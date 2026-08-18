import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	AO_BROWSER_PERSISTENT_PARTITION,
	createBrowserProfileStorage,
	type BrowserProfilePersistence,
} from "./browser-profile-storage";

describe("browser profile storage", () => {
	let stateDir: string | undefined;

	afterEach(async () => {
		if (stateDir) await rm(stateDir, { recursive: true, force: true });
		stateDir = undefined;
	});

	it("allocates distinct memory-only partitions by default", () => {
		const ids = ["worker-a", "worker-b"];
		const storage = createBrowserProfileStorage(() => ids.shift() ?? "unexpected");

		expect(storage.partitionFor()).toBe("ao-browser-worker-a");
		expect(storage.partitionFor()).toBe("ao-browser-worker-b");
		expect(storage.partitionFor()).not.toMatch(/^persist:/);
	});

	it("returns one fixed AO-owned destination only for an explicit persistent choice", () => {
		const storage = createBrowserProfileStorage(() => "must-not-be-used");
		const persistence: BrowserProfilePersistence = "persistent";

		expect(storage.partitionFor(persistence)).toBe(AO_BROWSER_PERSISTENT_PARTITION);
		expect(storage.partitionFor(persistence)).toBe(AO_BROWSER_PERSISTENT_PARTITION);
		expect(storage.isPersistentDestinationActive()).toBe(true);
	});

	it("keeps the persisted choice ephemeral until an explicit selection is saved", async () => {
		stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-browser-profile-"));
		const storage = createBrowserProfileStorage({ stateDir, randomId: () => "worker" });

		expect(storage.getPersistence()).toBe("ephemeral");
		expect(await storage.load()).toBe("ephemeral");
		await storage.selectPersistence("persistent");

		const restarted = createBrowserProfileStorage({ stateDir, randomId: () => "worker-2" });
		expect(await restarted.load()).toBe("persistent");
		expect(restarted.getPersistence()).toBe("persistent");
		expect(restarted.partitionFor(restarted.getPersistence())).toBe(AO_BROWSER_PERSISTENT_PARTITION);
	});

	it("falls back to ephemeral for corrupt selection state", async () => {
		stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-browser-profile-"));
		await writeFile(path.join(stateDir, "browser-profile-settings.json"), "{not json", "utf8");

		const storage = createBrowserProfileStorage({ stateDir });
		expect(await storage.load()).toBe("ephemeral");
	});

	it("round-trips the import summary atomically", async () => {
		stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-browser-profile-"));
		const storage = createBrowserProfileStorage({ stateDir });
		const summary = {
			sourceBrowser: "chrome" as const,
			sourceProfile: "Default profile",
			importedBookmarks: 3,
			skippedBookmarks: 1,
			importedAt: "2026-08-18T00:00:00.000Z",
		};

		await storage.writeImportSummary(summary);
		expect(await storage.readImportSummary()).toEqual(summary);
		expect(await readdir(stateDir)).toEqual(["browser-import-summary.json"]);
		expect(await readFile(path.join(stateDir, "browser-import-summary.json"), "utf8")).toContain(
			"Default profile",
		);
	});
});
