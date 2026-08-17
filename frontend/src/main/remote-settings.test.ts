// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createRemoteSettingsStore,
	REMOTE_CONFIG_FILE_NAME,
	REMOTE_SECRET_FILE_NAME,
	type SafeStorageLike,
} from "./remote-settings";

const REMOTE_URL = "https://daemon.tail-scale.ts.net";
const OTHER_URL = "https://other.tail-scale.ts.net";
// Contains characters outside the base64 alphabet so the fake-encrypted blob
// can never contain this string literally.
const PASSWORD = "correct-horse-battery-staple!";

type FakeSafeStorage = SafeStorageLike & {
	encryptionAvailable: boolean;
	selectedBackend: string;
};

function createFakeSafeStorage(): FakeSafeStorage {
	const fake: FakeSafeStorage = {
		encryptionAvailable: true,
		selectedBackend: "gnome_libsecret",
		isEncryptionAvailable: () => fake.encryptionAvailable,
		getSelectedStorageBackend: () => fake.selectedBackend,
		encryptString: (value: string) =>
			Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8"),
		decryptString: (value: Buffer) =>
			Buffer.from(value.toString("utf8"), "base64").toString("utf8"),
	};
	return fake;
}

describe("remote-settings", () => {
	let dir: string;
	let safeStorage: FakeSafeStorage;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "ao-remote-settings-"));
		safeStorage = createFakeSafeStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(dir, { recursive: true, force: true });
	});

	it("returns defaults when no files exist", async () => {
		const store = createRemoteSettingsStore(dir, { safeStorage });
		expect(await store.readConfig()).toEqual({ mode: "local" });
		expect(await store.readPassword()).toBeNull();
	});

	it("round-trips the config, normalized to an https origin, with mode 0600", async () => {
		const store = createRemoteSettingsStore(dir, { safeStorage });
		await store.writeConfig({ mode: "remote", url: `${REMOTE_URL}/some/path?x=1` });
		expect(await store.readConfig()).toEqual({ mode: "remote", url: REMOTE_URL });

		const info = await stat(path.join(dir, REMOTE_CONFIG_FILE_NAME));
		expect(info.mode & 0o777).toBe(0o600);

		const fresh = createRemoteSettingsStore(dir, { safeStorage });
		expect(await fresh.readConfig()).toEqual({ mode: "remote", url: REMOTE_URL });
	});

	it("falls back to defaults and removes a corrupt config file", async () => {
		await writeFile(path.join(dir, REMOTE_CONFIG_FILE_NAME), "{not json", "utf8");
		const store = createRemoteSettingsStore(dir, { safeStorage });
		expect(await store.readConfig()).toEqual({ mode: "local" });
		await expect(stat(path.join(dir, REMOTE_CONFIG_FILE_NAME))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("round-trips the password through an encrypted, non-plaintext blob", async () => {
		const store = createRemoteSettingsStore(dir, { safeStorage });
		await store.writeConfig({ mode: "remote", url: REMOTE_URL });
		await store.writePassword(REMOTE_URL, PASSWORD);

		expect(store.isPasswordPersistent()).toBe(true);
		expect(await store.readPassword()).toBe(PASSWORD);

		const blob = await readFile(path.join(dir, REMOTE_SECRET_FILE_NAME));
		expect(blob.toString("utf8")).not.toContain(PASSWORD);
		const info = await stat(path.join(dir, REMOTE_SECRET_FILE_NAME));
		expect(info.mode & 0o777).toBe(0o600);

		const fresh = createRemoteSettingsStore(dir, { safeStorage });
		expect(await fresh.readPassword()).toBe(PASSWORD);
	});

	it("keeps the password memory-only when encryption is unavailable", async () => {
		safeStorage.encryptionAvailable = false;
		const store = createRemoteSettingsStore(dir, { safeStorage });
		await store.writeConfig({ mode: "remote", url: REMOTE_URL });
		await store.writePassword(REMOTE_URL, PASSWORD);

		expect(store.isPasswordPersistent()).toBe(false);
		expect(await store.readPassword()).toBe(PASSWORD);
		expect(await readdir(dir)).not.toContain(REMOTE_SECRET_FILE_NAME);

		const fresh = createRemoteSettingsStore(dir, { safeStorage });
		expect(await fresh.readPassword()).toBeNull();
	});

	it("treats the Linux basic_text backend as unavailable", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		safeStorage.selectedBackend = "basic_text";
		const store = createRemoteSettingsStore(dir, { safeStorage });
		await store.writeConfig({ mode: "remote", url: REMOTE_URL });
		await store.writePassword(REMOTE_URL, PASSWORD);

		expect(store.isPasswordPersistent()).toBe(false);
		expect(await store.readPassword()).toBe(PASSWORD);
		expect(await readdir(dir)).not.toContain(REMOTE_SECRET_FILE_NAME);

		const fresh = createRemoteSettingsStore(dir, { safeStorage });
		expect(await fresh.readPassword()).toBeNull();
	});

	it("returns null when the stored url does not match the config url", async () => {
		const store = createRemoteSettingsStore(dir, { safeStorage });
		await store.writeConfig({ mode: "remote", url: REMOTE_URL });
		await store.writePassword(REMOTE_URL, PASSWORD);
		await store.writeConfig({ mode: "remote", url: OTHER_URL });

		expect(await store.readPassword()).toBeNull();
	});

	it("treats a corrupt blob as absent and deletes it", async () => {
		const store = createRemoteSettingsStore(dir, { safeStorage });
		await store.writeConfig({ mode: "remote", url: REMOTE_URL });
		await writeFile(path.join(dir, REMOTE_SECRET_FILE_NAME), Buffer.from("garbage-bytes"), {
			mode: 0o600,
		});

		expect(await store.readPassword()).toBeNull();
		await expect(stat(path.join(dir, REMOTE_SECRET_FILE_NAME))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("clear() removes both files", async () => {
		const store = createRemoteSettingsStore(dir, { safeStorage });
		await store.writeConfig({ mode: "remote", url: REMOTE_URL });
		await store.writePassword(REMOTE_URL, PASSWORD);

		await store.clear();

		expect(await readdir(dir)).toEqual([]);
		expect(await store.readConfig()).toEqual({ mode: "local" });
		expect(await store.readPassword()).toBeNull();
	});

	it("clear() drops the memory-only password", async () => {
		safeStorage.encryptionAvailable = false;
		const store = createRemoteSettingsStore(dir, { safeStorage });
		await store.writeConfig({ mode: "remote", url: REMOTE_URL });
		await store.writePassword(REMOTE_URL, PASSWORD);
		expect(await store.readPassword()).toBe(PASSWORD);

		await store.clear();

		expect(await store.readPassword()).toBeNull();
		expect(await readdir(dir)).toEqual([]);
	});
});
