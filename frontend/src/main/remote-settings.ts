import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { DaemonConnectionMode } from "../shared/daemon-status";

export type { DaemonConnectionMode } from "../shared/daemon-status";

/** Non-secret daemon-connection prefs under the ~/.ao state dir. */
export const REMOTE_CONFIG_FILE_NAME = "remote-daemon.json";
/** safeStorage-encrypted blob holding the remote daemon password. */
export const REMOTE_SECRET_FILE_NAME = "remote-daemon.bin";

export type RemoteDaemonConfig = {
	mode: DaemonConnectionMode;
	/** Validated https origin; only meaningful when mode === "remote". */
	url?: string;
};

export const DEFAULT_REMOTE_DAEMON_CONFIG: RemoteDaemonConfig = { mode: "local" };

/** Subset of Electron's safeStorage this module needs, injectable for tests. */
export interface SafeStorageLike {
	isEncryptionAvailable(): boolean;
	getSelectedStorageBackend(): string;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
}

export type RemoteSettingsDeps = {
	safeStorage?: SafeStorageLike;
};

export type RemoteSettingsStore = {
	/** Read the config, tolerating a missing or corrupt file (returns defaults). */
	readConfig(): Promise<RemoteDaemonConfig>;
	/** Atomically and serially write the config (temp file + rename). */
	writeConfig(cfg: RemoteDaemonConfig): Promise<void>;
	/** Decrypted password, or null when absent, unreadable, or stored for another url. */
	readPassword(): Promise<string | null>;
	/** Persist the password for a url; memory-only when OS encryption is unavailable. */
	writePassword(url: string, password: string): Promise<void>;
	/** Forget everything: delete both files and any in-memory secret. */
	clear(): Promise<void>;
	/** false => the password is kept in memory only for this process. */
	isPasswordPersistent(): boolean;
};

type StoredSecret = { url: string; password: string };

function coerceRemoteDaemonConfig(value: unknown): RemoteDaemonConfig {
	if (!value || typeof value !== "object") return { ...DEFAULT_REMOTE_DAEMON_CONFIG };
	const raw = value as { mode?: unknown; url?: unknown };
	if (raw.mode !== "remote") return { ...DEFAULT_REMOTE_DAEMON_CONFIG };
	if (typeof raw.url !== "string") return { mode: "remote" };
	try {
		const parsed = new URL(raw.url);
		if (parsed.protocol !== "https:") return { mode: "remote" };
		return { mode: "remote", url: parsed.origin };
	} catch {
		return { mode: "remote" };
	}
}

/**
 * Persistence for the desktop's daemon-connection settings. Mirrors the
 * ui-settings JSON store (atomic writes, 0600/0750, serialized queue) and the
 * cloud-auth secret store (safeStorage-encrypted blob, memory-only fallback,
 * never plaintext on disk). Electron's safeStorage is resolved lazily so the
 * module loads under plain-node vitest; tests inject a fake via deps.
 */
export function createRemoteSettingsStore(
	dataDir: string,
	deps: RemoteSettingsDeps = {},
): RemoteSettingsStore {
	const configPath = path.join(dataDir, REMOTE_CONFIG_FILE_NAME);
	const secretPath = path.join(dataDir, REMOTE_SECRET_FILE_NAME);

	// Memory-only secret fallback, scoped to this store instance: used when the
	// OS keychain is unavailable so the password never touches disk in
	// plaintext. Process-local by design — a new store instance (or a restart)
	// starts empty.
	let memorySecret: StoredSecret | null = null;

	let operationQueue: Promise<void> = Promise.resolve();
	function runSerialized<T>(operation: () => Promise<T>): Promise<T> {
		const queued = operationQueue.then(operation, operation);
		operationQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	let cachedSafeStorage: SafeStorageLike | null | undefined;
	function safeStorage(): SafeStorageLike | null {
		if (cachedSafeStorage !== undefined) return cachedSafeStorage;
		if (deps.safeStorage) {
			cachedSafeStorage = deps.safeStorage;
			return cachedSafeStorage;
		}
		try {
			const require = createRequire(import.meta.url);
			cachedSafeStorage =
				(require("electron") as { safeStorage?: SafeStorageLike }).safeStorage ?? null;
		} catch {
			cachedSafeStorage = null;
		}
		return cachedSafeStorage;
	}

	function protectedStorageAvailable(): boolean {
		const storage = safeStorage();
		if (!storage) return false;
		if (!storage.isEncryptionAvailable()) return false;
		if (process.platform !== "linux") return true;
		const backend = storage.getSelectedStorageBackend();
		return backend !== "basic_text" && backend !== "unknown";
	}

	async function readConfigUnlocked(): Promise<RemoteDaemonConfig> {
		let raw: string;
		try {
			raw = await readFile(configPath, "utf8");
		} catch {
			return { ...DEFAULT_REMOTE_DAEMON_CONFIG };
		}
		try {
			return coerceRemoteDaemonConfig(JSON.parse(raw));
		} catch {
			await rm(configPath, { force: true });
			return { ...DEFAULT_REMOTE_DAEMON_CONFIG };
		}
	}

	async function writeConfigUnlocked(cfg: RemoteDaemonConfig): Promise<void> {
		const next = coerceRemoteDaemonConfig(cfg);
		await mkdir(dataDir, { recursive: true, mode: 0o750 });
		const data = `${JSON.stringify(next, null, 2)}\n`;
		const tmp = path.join(dataDir, `.remote-daemon-${process.pid}-${Date.now()}.json`);
		await writeFile(tmp, data, { mode: 0o600 });
		await rename(tmp, configPath);
	}

	async function readSecretUnlocked(): Promise<StoredSecret | null> {
		if (memorySecret) return memorySecret;
		const storage = safeStorage();
		if (!storage || !protectedStorageAvailable()) {
			await rm(secretPath, { force: true });
			return null;
		}
		try {
			const parsed = JSON.parse(storage.decryptString(await readFile(secretPath))) as {
				url?: unknown;
				password?: unknown;
			};
			if (typeof parsed.url !== "string" || typeof parsed.password !== "string") {
				throw new Error("malformed remote-daemon secret");
			}
			return { url: parsed.url, password: parsed.password };
		} catch {
			await rm(secretPath, { force: true });
			return null;
		}
	}

	async function writeSecretUnlocked(secret: StoredSecret): Promise<void> {
		const storage = safeStorage();
		if (!storage || !protectedStorageAvailable()) {
			// The password must never fall back to plaintext persistence. Linux's
			// basic_text backend also reports encryption as available despite using
			// an unprotected hardcoded password, so keep that process-local too.
			memorySecret = secret;
			await rm(secretPath, { force: true });
			return;
		}
		memorySecret = null;
		await mkdir(dataDir, { recursive: true, mode: 0o750 });
		await writeFile(secretPath, storage.encryptString(JSON.stringify(secret)), { mode: 0o600 });
		await chmod(secretPath, 0o600);
	}

	async function clearUnlocked(): Promise<void> {
		memorySecret = null;
		await Promise.all([
			rm(configPath, { force: true }),
			rm(secretPath, { force: true }),
		]);
	}

	return {
		readConfig: () => readConfigUnlocked(),
		writeConfig: (cfg) => runSerialized(() => writeConfigUnlocked(cfg)),
		readPassword: async () => {
			const cfg = await readConfigUnlocked();
			if (cfg.mode !== "remote" || !cfg.url) return null;
			const secret = await readSecretUnlocked();
			if (!secret || secret.url !== cfg.url) return null;
			return secret.password;
		},
		writePassword: (url, password) => runSerialized(() => writeSecretUnlocked({ url, password })),
		clear: () => runSerialized(clearUnlocked),
		isPasswordPersistent: () => protectedStorageAvailable(),
	};
}
