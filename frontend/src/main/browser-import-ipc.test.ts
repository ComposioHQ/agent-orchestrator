import { describe, expect, it, vi } from "vitest";
import {
	BROWSER_BOOKMARKS_GET_CHANNEL,
	BROWSER_IMPORT_DETECT_CHANNEL,
	BROWSER_IMPORT_IMPORT_CHANNEL,
	BROWSER_IMPORT_STATUS_CHANNEL,
	BROWSER_IMPORT_USE_EPHEMERAL_CHANNEL,
	createBrowserImportController,
	registerBrowserImportIPC,
} from "./browser-import-ipc";
import type { BrowserBookmarkDocument } from "./browser-bookmark-store";

function bookmarkDocument(fingerprint = "a".repeat(64)): BrowserBookmarkDocument {
	return {
		version: 1,
		source: { browser: "chrome", profile: "Default profile", fingerprint },
		importedAt: "2026-08-18T00:00:00.000Z",
		importedBookmarks: 2,
		 skippedBookmarks: 1,
		roots: {
			bookmark_bar: {
				type: "folder",
				id: "bar",
				name: "Bookmarks bar",
				children: [{ type: "url", id: "docs", name: "Docs", url: "https://ao.example.test/docs" }],
			},
			other: { type: "folder", id: "other", name: "Other", children: [] },
			synced: { type: "folder", id: "synced", name: "Synced", children: [] },
		},
	};
}

function storage() {
	let persistence: "ephemeral" | "persistent" = "ephemeral";
	return {
		partitionFor: vi.fn(() => "ao-browser-test"),
		releasePartition: vi.fn(),
		getPersistence: () => persistence,
		load: vi.fn(async () => persistence),
		selectPersistence: vi.fn(async (next: "ephemeral" | "persistent") => {
			persistence = next;
			return next;
		}),
		isPersistentDestinationActive: vi.fn(() => false),
	};
}

function bookmarkStorage() {
	let current: BrowserBookmarkDocument | null = null;
	return {
		read: vi.fn(async () => current),
		write: vi.fn(async (next: BrowserBookmarkDocument) => {
			if (current && current.source.fingerprint !== next.source.fingerprint) {
				throw Object.assign(new Error("already populated"), { code: "DESTINATION_NOT_EMPTY" });
			}
			if (current) return { created: false, document: current };
			current = next;
			return { created: true, document: next };
		}),
		removeIfMatches: vi.fn(async (next: BrowserBookmarkDocument) => {
			if (current?.source.fingerprint === next.source.fingerprint) current = null;
		}),
	};
}

function engine() {
	return {
		detect: vi.fn(async () => ({ sources: [], supportedData: ["bookmarks"] as const })),
		importSource: vi.fn(async (_sourceId: string) => ({
			sourceBrowser: "chrome" as const,
			sourceProfile: "Default profile",
			importedBookmarks: 2,
			skippedBookmarks: 1,
			destination: "ao-persistent-browser" as const,
			bookmarks: bookmarkDocument().roots,
			sourceFingerprint: "a".repeat(64),
		})),
	};
}

describe("browser import controller", () => {
	it("requires activate:true before reading or writing any import state", async () => {
		const profileStorage = storage();
		const browserEngine = engine();
		const importedStorage = bookmarkStorage();
		const controller = createBrowserImportController({
			engine: browserEngine,
			profileStorage,
			bookmarkStorage: importedStorage,
		});

		await expect(controller.importSource({ sourceId: "source-1" })).rejects.toThrow(/activation must be true/);
		await expect(controller.importSource({ sourceId: "source-1", activate: false })).rejects.toThrow(/activation must be true/);
		expect(browserEngine.importSource).not.toHaveBeenCalled();
		expect(importedStorage.write).not.toHaveBeenCalled();

		const result = await controller.importSource({ sourceId: "source-1", activate: true });
		expect(result.persistence).toBe("persistent");
		expect(profileStorage.selectPersistence).toHaveBeenCalledWith("persistent");
		expect(importedStorage.write).toHaveBeenCalledWith(expect.objectContaining({ version: 1, importedBookmarks: 2 }));
	});

	it("rolls back a newly written store when persistence activation fails", async () => {
		const profileStorage = storage();
		profileStorage.selectPersistence.mockRejectedValueOnce(new Error("settings unavailable"));
		const importedStorage = bookmarkStorage();
		const controller = createBrowserImportController({ engine: engine(), profileStorage, bookmarkStorage: importedStorage });

		await expect(controller.importSource({ sourceId: "source-1", activate: true })).rejects.toThrow("settings unavailable");
		expect(importedStorage.removeIfMatches).toHaveBeenCalledOnce();
		expect(await importedStorage.read()).toBeNull();
	});

	it("serializes operations, reports the AO bookmark tree, and supports switching future workers back to temporary storage", async () => {
		const profileStorage = storage();
		const importedStorage = bookmarkStorage();
		const controller = createBrowserImportController({ engine: engine(), profileStorage, bookmarkStorage: importedStorage });

		await controller.importSource({ sourceId: "source-1", activate: true });
		const status = await controller.getStatus();
		expect(status.summary).toMatchObject({ sourceBrowser: "chrome", importedBookmarks: 2 });
		expect(await controller.getBookmarks()).toMatchObject({ roots: { bookmark_bar: { children: [{ url: "https://ao.example.test/docs" }] } } });
		expect((await controller.useEphemeral()).persistence).toBe("ephemeral");
		expect(profileStorage.selectPersistence).toHaveBeenLastCalledWith("ephemeral");
	});
});

describe("browser import IPC boundary", () => {
	it("rejects non-shell senders before reaching the controller", async () => {
		const handlers = new Map<string, (event: { sender: object }, input?: unknown) => unknown>();
		const controller = {
			detect: vi.fn(),
			importSource: vi.fn(),
			getStatus: vi.fn(),
			useEphemeral: vi.fn(),
			getBookmarks: vi.fn(),
		};
		const trustedSender = {};
		registerBrowserImportIPC({
			ipcMain: { handle: (channel, handler) => handlers.set(channel, handler as never) },
			getTrustedSender: () => trustedSender as never,
			getController: () => controller,
		});

		await expect(Promise.resolve().then(() => handlers.get(BROWSER_IMPORT_DETECT_CHANNEL)!({ sender: {} }))).rejects.toThrow(/AO shell/);
		expect(controller.detect).not.toHaveBeenCalled();
	});

	it("routes only trusted calls and exposes no source path", async () => {
		const handlers = new Map<string, (event: { sender: object }, input?: unknown) => unknown>();
		const trustedSender = {};
		const controller = {
			detect: vi.fn(async () => ({ sources: [], supportedData: ["bookmarks"] as const })),
			importSource: vi.fn(async (_input: unknown) => ({
				sourceBrowser: "chrome" as const,
				sourceProfile: "Default profile",
				importedBookmarks: 0,
				skippedBookmarks: 0,
				destination: "ao-persistent-browser" as const,
				persistence: "persistent" as const,
			})),
			getStatus: vi.fn(async () => ({ persistence: "ephemeral" as const, destinationActive: false, summary: null })),
			useEphemeral: vi.fn(async () => ({ persistence: "ephemeral" as const, destinationActive: false, summary: null })),
			getBookmarks: vi.fn(async () => null),
		};
		registerBrowserImportIPC({
			ipcMain: { handle: (channel, handler) => handlers.set(channel, handler as never) },
			getTrustedSender: () => trustedSender as never,
			getController: () => controller,
		});

		await expect(
			Promise.resolve().then(() =>
				handlers.get(BROWSER_IMPORT_IMPORT_CHANNEL)!({ sender: trustedSender }, { sourceId: "opaque-id", activate: false }),
			),
		).rejects.toThrow(/activation must be true/);
		expect(controller.importSource).not.toHaveBeenCalled();
		await handlers.get(BROWSER_IMPORT_IMPORT_CHANNEL)!({ sender: trustedSender }, { sourceId: "opaque-id", activate: true });
		await handlers.get(BROWSER_IMPORT_STATUS_CHANNEL)!({ sender: trustedSender });
		await handlers.get(BROWSER_IMPORT_USE_EPHEMERAL_CHANNEL)!({ sender: trustedSender });
		await handlers.get(BROWSER_BOOKMARKS_GET_CHANNEL)!({ sender: trustedSender });

		expect(controller.importSource).toHaveBeenCalledWith({ sourceId: "opaque-id", activate: true });
		expect(controller.getBookmarks).toHaveBeenCalled();
	});
});
