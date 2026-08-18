import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The one AO-owned persistent browser destination. Electron stores data for a
 * persistent partition below its session-data directory; main.ts pins that
 * directory under ~/.ao before Electron is ready.
 */
export const AO_BROWSER_PERSISTENT_PARTITION = "persist:ao-browser";
export const BROWSER_PROFILE_SETTINGS_FILE_NAME = "browser-profile-settings.json";

const EPHEMERAL_PARTITION_PREFIX = "ao-browser-";

export type BrowserProfilePersistence = "ephemeral" | "persistent";

export type BrowserImportBrowser = "chrome" | "edge" | "brave";

export type BrowserImportSummary = {
	sourceBrowser: BrowserImportBrowser;
	sourceProfile: string;
	importedBookmarks: number;
	skippedBookmarks: number;
	importedAt: string;
};

export type BrowserProfileStorageOptions = {
	stateDir?: string;
	randomId?: () => string;
};

/**
 * Main-process-only seam for choosing the browser storage destination. The
 * persistent destination is deliberately singular; named profiles and source
 * browser storage do not belong in this layer.
 */
export type BrowserProfileStorage = {
	partitionFor: (persistence?: BrowserProfilePersistence) => string;
	releasePartition: (partition: string) => void;
	getPersistence: () => BrowserProfilePersistence;
	load: () => Promise<BrowserProfilePersistence>;
	selectPersistence: (persistence: BrowserProfilePersistence) => Promise<BrowserProfilePersistence>;
	isPersistentDestinationActive: () => boolean;
};

const DEFAULT_PERSISTENCE: BrowserProfilePersistence = "ephemeral";

function coercePersistence(value: unknown): BrowserProfilePersistence {
	return value === "persistent" ? "persistent" : DEFAULT_PERSISTENCE;
}

async function readJson(stateDir: string, fileName: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path.join(stateDir, fileName), "utf8"));
	} catch {
		return null;
	}
}

async function writeJson(stateDir: string, fileName: string, value: unknown): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	const file = path.join(stateDir, fileName);
	const tmp = path.join(stateDir, `.${fileName}-${process.pid}-${Date.now()}.tmp`);
	try {
		await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		await rename(tmp, file);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function createBrowserProfileStorage(
	options: BrowserProfileStorageOptions | (() => string) = {},
): BrowserProfileStorage {
	const { stateDir, randomId = randomUUID } =
		typeof options === "function" ? { randomId: options } : options;
	let selectedPersistence: BrowserProfilePersistence = DEFAULT_PERSISTENCE;
	let persistentDestinationReferences = 0;
	let operationQueue: Promise<unknown> = Promise.resolve();

	const runOperation = <T>(operation: () => Promise<T>): Promise<T> => {
		const queued = operationQueue.then(operation, operation);
		operationQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	};

	return {
		partitionFor: (persistence = DEFAULT_PERSISTENCE) => {
			if (persistence === "persistent") {
				persistentDestinationReferences += 1;
				return AO_BROWSER_PERSISTENT_PARTITION;
			}
			return `${EPHEMERAL_PARTITION_PREFIX}${randomId()}`;
		},
		releasePartition: (partition) => {
			if (partition !== AO_BROWSER_PERSISTENT_PARTITION) return;
			persistentDestinationReferences = Math.max(0, persistentDestinationReferences - 1);
		},
		getPersistence: () => selectedPersistence,
		load: async () => {
			if (!stateDir) return selectedPersistence;
			return runOperation(async () => {
				const value = await readJson(stateDir, BROWSER_PROFILE_SETTINGS_FILE_NAME);
				selectedPersistence =
					typeof value === "object" && value !== null
						? coercePersistence((value as { persistence?: unknown }).persistence)
						: DEFAULT_PERSISTENCE;
				return selectedPersistence;
			});
		},
		selectPersistence: async (persistence) => {
			const next = coercePersistence(persistence);
			if (!stateDir) {
				selectedPersistence = next;
				return selectedPersistence;
			}
			return runOperation(async () => {
				await writeJson(stateDir, BROWSER_PROFILE_SETTINGS_FILE_NAME, { version: 1, persistence: next });
				selectedPersistence = next;
				return selectedPersistence;
			});
		},
		isPersistentDestinationActive: () => persistentDestinationReferences > 0,
	};
}
