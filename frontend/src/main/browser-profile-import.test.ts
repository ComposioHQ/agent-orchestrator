import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserHistoryStore } from "./browser-history-store";
import { BrowserProfileImportService } from "./browser-profile-import";
import { BrowserProfileStore } from "./browser-profile-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ao-browser-import-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function createChromeFixture(root: string): Promise<{ localAppData: string; profileRoot: string }> {
	const localAppData = path.join(root, "local");
	const userData = path.join(localAppData, "Google", "Chrome", "User Data");
	const profileRoot = path.join(userData, "Default");
	await mkdir(path.join(profileRoot, "Network"), { recursive: true });
	await writeFile(path.join(userData, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" } } } }));

	const cookies = new Database(path.join(profileRoot, "Network", "Cookies"));
	cookies.exec(`
		CREATE TABLE cookies (
			host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
			expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER
		)
	`);
	const future = chromiumMicros("2030-01-01T00:00:00.000Z");
	const past = chromiumMicros("2020-01-01T00:00:00.000Z");
	const insertCookie = cookies.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	insertCookie.run(".github.com", "session", "usable", Buffer.alloc(0), "/", future, 1, 1, 1);
	insertCookie.run(".github.com", "empty", "", Buffer.alloc(0), "/", future, 1, 0, 1);
	insertCookie.run(".github.com", "app-bound", "", Buffer.from("v20-unavailable"), "/", future, 1, 1, 1);
	insertCookie.run(".github.com", "expired", "old", Buffer.alloc(0), "/", past, 1, 0, 1);
	insertCookie.run(".example.com", "filtered", "nope", Buffer.alloc(0), "/", future, 1, 0, 1);
	cookies.close();

	const history = new Database(path.join(profileRoot, "History"));
	history.exec("CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER)");
	const insertHistory = history.prepare("INSERT INTO urls VALUES (?, ?, ?, ?)");
	insertHistory.run("https://github.com/openai", "OpenAI", 4, chromiumMicros("2026-01-01T00:00:00.000Z"));
	insertHistory.run("https://example.com/private", "Filtered", 1, chromiumMicros("2026-01-02T00:00:00.000Z"));
	history.close();
	return { localAppData, profileRoot };
}

function chromiumMicros(iso: string): number {
	return Math.round((Date.parse(iso) / 1_000 + 11_644_473_600) * 1_000_000);
}

describe("BrowserProfileImportService", () => {
	it("discovers path-hidden profiles and atomically imports filtered cookies and history", async () => {
		const root = await fixtureRoot();
		const { localAppData } = await createChromeFixture(root);
		const stateDir = path.join(root, "ao-state");
		const profileStore = new BrowserProfileStore({ stateDir });
		await profileStore.load();
		const historyStore = new BrowserHistoryStore({ stateDir });
		const cookiesByPartition = new Map<string, unknown[]>();
		const cleared: string[] = [];
		const service = new BrowserProfileImportService({
			stateDir,
			profileStore,
			historyStore,
			platform: "win32",
			homeDir: root,
			env: { LOCALAPPDATA: localAppData },
			now: () => new Date("2026-01-01T00:00:00.000Z"),
			fromPartition: (partition) => ({
				cookies: { set: async (cookie) => { cookiesByPartition.set(partition, [...(cookiesByPartition.get(partition) ?? []), cookie]); } },
				clearStorageData: async () => { cleared.push(partition); },
				clearCache: async () => undefined,
			}),
		});
		const discovery = await service.discover();
		expect(discovery.sources).toHaveLength(1);
		expect(JSON.stringify(discovery)).not.toContain(root);
		const source = discovery.sources[0]!;
		const sourceProfile = source.profiles[0]!;
		const progress = vi.fn();
		const result = await service.import({
			requestId: "22222222-2222-4222-8222-222222222222",
			sourceId: source.id,
			profileIds: [sourceProfile.id],
			includeCookies: true,
			includeHistory: true,
			domains: ["github.com"],
			destination: { mode: "merge", name: "Imported Chrome" },
		}, progress);

		expect(result.entries[0]).toMatchObject({ importedCookies: 2, skippedCookies: 2, importedHistoryEntries: 1 });
		expect(result.entries[0]!.warnings).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: "encrypted-cookies-skipped", count: 1 }),
			expect.objectContaining({ code: "expired-cookies-skipped", count: 1 }),
		]));
		expect([...cookiesByPartition.values()][0]).toHaveLength(2);
		expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "importing", completed: 1, total: 1 }));
		const importedProfile = result.entries[0]!.destinationProfile;
		expect(await new BrowserHistoryStore({ stateDir }).suggest(importedProfile.id, "openai")).toEqual([
			{ url: "https://github.com/openai", title: "OpenAI" },
		]);
		expect((await new BrowserProfileStore({ stateDir }).load()).profiles).toHaveLength(1);

		await expect(service.import({
			requestId: "33333333-3333-4333-8333-333333333333",
			sourceId: source.id,
			profileIds: [sourceProfile.id],
			includeCookies: true,
			includeHistory: false,
			domains: [],
			destination: { mode: "merge", name: "Imported Chrome" },
		}, vi.fn())).rejects.toThrow("already exists");
		expect(cleared).toEqual([]);
	});

	it("rolls back a failed destination and allows a clean retry", async () => {
		const root = await fixtureRoot();
		const { localAppData } = await createChromeFixture(root);
		const stateDir = path.join(root, "ao-state");
		const profileStore = new BrowserProfileStore({ stateDir });
		await profileStore.load();
		const historyStore = new BrowserHistoryStore({ stateDir });
		vi.spyOn(historyStore, "mergeImportedEntries").mockRejectedValueOnce(new Error("disk full"));
		const service = new BrowserProfileImportService({
			stateDir,
			profileStore,
			historyStore,
			platform: "win32",
			homeDir: root,
			env: { LOCALAPPDATA: localAppData },
			fromPartition: () => ({ cookies: { set: async () => undefined }, clearStorageData: async () => undefined, clearCache: async () => undefined }),
		});
		const source = (await service.discover()).sources[0]!;
		const request = {
			requestId: "44444444-4444-4444-8444-444444444444",
			sourceId: source.id,
			profileIds: [source.profiles[0]!.id],
			includeCookies: false,
			includeHistory: true,
			domains: [],
			destination: { mode: "merge" as const, name: "Retryable" },
		};
		await expect(service.import(request, vi.fn())).rejects.toThrow("disk full");
		expect(profileStore.profiles).toEqual([]);
		await expect(service.import({ ...request, requestId: "55555555-5555-4555-8555-555555555555" }, vi.fn())).resolves.toMatchObject({
			entries: [expect.objectContaining({ importedHistoryEntries: 2 })],
		});
	});

	it("removes the destination when Electron session creation fails and permits retry", async () => {
		const root = await fixtureRoot();
		const { localAppData } = await createChromeFixture(root);
		const stateDir = path.join(root, "ao-state");
		const profileStore = new BrowserProfileStore({ stateDir });
		await profileStore.load();
		let sessionAvailable = false;
		const service = new BrowserProfileImportService({
			stateDir,
			profileStore,
			historyStore: new BrowserHistoryStore({ stateDir }),
			platform: "win32",
			homeDir: root,
			env: { LOCALAPPDATA: localAppData },
			fromPartition: () => {
				if (!sessionAvailable) throw new Error("session unavailable");
				return { cookies: { set: async () => undefined }, clearStorageData: async () => undefined, clearCache: async () => undefined };
			},
		});
		const source = (await service.discover()).sources[0]!;
		const request = {
			requestId: "88888888-8888-4888-8888-888888888888",
			sourceId: source.id,
			profileIds: [source.profiles[0]!.id],
			includeCookies: true,
			includeHistory: false,
			domains: [],
			destination: { mode: "merge" as const, name: "Retry Session" },
		};

		await expect(service.import(request, vi.fn())).rejects.toThrow("session unavailable");
		expect(profileStore.profiles).toEqual([]);
		sessionAvailable = true;
		await expect(service.import({ ...request, requestId: "99999999-9999-4999-8999-999999999999" }, vi.fn())).resolves.toMatchObject({
			entries: [expect.objectContaining({ destinationProfile: expect.objectContaining({ name: "Retry Session" }) })],
		});
	});

	it("rejects an oversized database before reading it", async () => {
		const root = await fixtureRoot();
		const localAppData = path.join(root, "local");
		const profileRoot = path.join(localAppData, "Google", "Chrome", "User Data", "Default");
		await mkdir(profileRoot, { recursive: true });
		await writeFile(path.join(localAppData, "Google", "Chrome", "User Data", "Local State"), "{}");
		const historyFile = path.join(profileRoot, "History");
		await writeFile(historyFile, "");
		await truncate(historyFile, 256 * 1024 * 1024 + 1);
		const stateDir = path.join(root, "ao-state");
		const profileStore = new BrowserProfileStore({ stateDir });
		await profileStore.load();
		const service = new BrowserProfileImportService({
			stateDir,
			profileStore,
			historyStore: new BrowserHistoryStore({ stateDir }),
			platform: "win32",
			homeDir: root,
			env: { LOCALAPPDATA: localAppData },
			fromPartition: () => ({ cookies: { set: async () => undefined }, clearStorageData: async () => undefined, clearCache: async () => undefined }),
		});
		const source = (await service.discover()).sources[0]!;
		await expect(service.import({
			requestId: "66666666-6666-4666-8666-666666666666",
			sourceId: source.id,
			profileIds: [source.profiles[0]!.id],
			includeCookies: false,
			includeHistory: true,
			domains: [],
			destination: { mode: "merge", name: "Too Large" },
		}, vi.fn())).rejects.toThrow("size limit");
		expect(profileStore.profiles).toEqual([]);
	});

	it("does not follow a source database symlink outside the browser profile", async () => {
		const root = await fixtureRoot();
		const localAppData = path.join(root, "local");
		const userData = path.join(localAppData, "Google", "Chrome", "User Data");
		const profileRoot = path.join(userData, "Default");
		await mkdir(path.join(profileRoot, "Network"), { recursive: true });
		await writeFile(path.join(userData, "Local State"), "{}");
		await writeFile(path.join(profileRoot, "Network", "Cookies"), "");
		const outside = path.join(root, "outside-history.sqlite");
		await writeFile(outside, "not a browser database");
		try {
			await symlink(outside, path.join(profileRoot, "History"), "file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}

		const stateDir = path.join(root, "ao-state");
		const profileStore = new BrowserProfileStore({ stateDir });
		await profileStore.load();
		const service = new BrowserProfileImportService({
			stateDir,
			profileStore,
			historyStore: new BrowserHistoryStore({ stateDir }),
			platform: "win32",
			homeDir: root,
			env: { LOCALAPPDATA: localAppData },
			fromPartition: () => ({ cookies: { set: async () => undefined }, clearStorageData: async () => undefined, clearCache: async () => undefined }),
		});
		const source = (await service.discover()).sources[0]!;
		const result = await service.import({
			requestId: "77777777-7777-4777-8777-777777777777",
			sourceId: source.id,
			profileIds: [source.profiles[0]!.id],
			includeCookies: false,
			includeHistory: true,
			domains: [],
			destination: { mode: "merge", name: "Contained" },
		}, vi.fn());

		expect(result.entries[0]).toMatchObject({
			importedHistoryEntries: 0,
			warnings: [expect.objectContaining({ code: "history-database-missing" })],
		});
	});
});
