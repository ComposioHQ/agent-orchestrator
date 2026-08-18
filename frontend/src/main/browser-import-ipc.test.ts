import { describe, expect, it, vi } from "vitest";
import {
	BROWSER_IMPORT_DETECT_CHANNEL,
	BROWSER_IMPORT_IMPORT_CHANNEL,
	BROWSER_IMPORT_STATUS_CHANNEL,
	BROWSER_IMPORT_USE_EPHEMERAL_CHANNEL,
	createBrowserImportController,
	registerBrowserImportIPC,
} from "./browser-import-ipc";

function storage() {
	let persistence: "ephemeral" | "persistent" = "ephemeral";
	const summary = { current: null as null | Record<string, unknown> };
	return {
		partitionFor: vi.fn(() => "ao-browser-test"),
		getPersistence: () => persistence,
		load: vi.fn(async () => persistence),
		selectPersistence: vi.fn(async (next: "ephemeral" | "persistent") => {
			persistence = next;
			return next;
		}),
		readImportSummary: vi.fn(async () => summary.current as never),
		writeImportSummary: vi.fn(async (next: Record<string, unknown>) => {
			summary.current = next;
			return next as never;
		}),
		isPersistentDestinationActive: vi.fn(() => false),
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
		})),
	};
}

describe("browser import controller", () => {
	it("requires an explicit activation boolean and selects persistence only when requested", async () => {
		const profileStorage = storage();
		const browserEngine = engine();
		const controller = createBrowserImportController({
			engine: browserEngine,
			profileStorage,
			now: () => new Date("2026-08-18T00:00:00.000Z"),
		});

		await expect(controller.importSource({ sourceId: "source-1" })).rejects.toThrow(/activation must be explicit/);
		expect(browserEngine.importSource).not.toHaveBeenCalled();

		const result = await controller.importSource({ sourceId: "source-1", activate: true });
		expect(result.persistence).toBe("persistent");
		expect(profileStorage.selectPersistence).toHaveBeenCalledWith("persistent");
		expect(profileStorage.writeImportSummary).toHaveBeenCalledWith(
			expect.objectContaining({ sourceBrowser: "chrome", importedBookmarks: 2 }),
		);
	});

	it("serializes operations and supports dismissing persistent use for future workers", async () => {
		const profileStorage = storage();
		const browserEngine = engine();
		const controller = createBrowserImportController({ engine: browserEngine, profileStorage });

		await controller.importSource({ sourceId: "source-1", activate: true });
		const status = await controller.useEphemeral();

		expect(status.persistence).toBe("ephemeral");
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
		};
		const trustedSender = {};
		registerBrowserImportIPC({
			ipcMain: { handle: (channel, handler) => handlers.set(channel, handler as never) },
			getTrustedSender: () => trustedSender as never,
			getController: () => controller,
		});

		await expect(
			Promise.resolve().then(() => handlers.get(BROWSER_IMPORT_DETECT_CHANNEL)!({ sender: {} })),
		).rejects.toThrow(/AO shell/);
		expect(controller.detect).not.toHaveBeenCalled();
	});

	it("routes only trusted calls to the controller and never adds a path argument", async () => {
		const handlers = new Map<string, (event: { sender: object }, input?: unknown) => unknown>();
		const controller = {
			detect: vi.fn(async () => ({ sources: [], supportedData: ["bookmarks"] as const })),
			importSource: vi.fn(async (_input: unknown) => ({
				sourceBrowser: "chrome" as const,
				sourceProfile: "Default profile",
				importedBookmarks: 0,
				skippedBookmarks: 0,
				destination: "ao-persistent-browser" as const,
				persistence: "ephemeral" as const,
			})),
			getStatus: vi.fn(async () => ({ persistence: "ephemeral" as const, destinationActive: false, summary: null })),
			useEphemeral: vi.fn(async () => ({ persistence: "ephemeral" as const, destinationActive: false, summary: null })),
		};
		const trustedSender = {};
		registerBrowserImportIPC({
			ipcMain: { handle: (channel, handler) => handlers.set(channel, handler as never) },
			getTrustedSender: () => trustedSender as never,
			getController: () => controller,
		});

		const result = await handlers.get(BROWSER_IMPORT_IMPORT_CHANNEL)!({ sender: trustedSender }, {
			sourceId: "opaque-id",
			activate: true,
		});
		await handlers.get(BROWSER_IMPORT_STATUS_CHANNEL)!({ sender: trustedSender });
		await handlers.get(BROWSER_IMPORT_USE_EPHEMERAL_CHANNEL)!({ sender: trustedSender });

		expect(result).toMatchObject({ destination: "ao-persistent-browser", persistence: "ephemeral" });
		expect(controller.importSource).toHaveBeenCalledWith({ sourceId: "opaque-id", activate: true });
		expect(controller.getStatus).toHaveBeenCalled();
		expect(controller.useEphemeral).toHaveBeenCalled();
	});
});
