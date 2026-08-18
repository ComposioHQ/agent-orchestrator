import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	AO_BROWSER_PERSISTENT_PARTITION,
	createBrowserProfileStorage,
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
		expect(storage.isPersistentDestinationActive()).toBe(false);
	});

	it("tracks live persistent workers and releases the destination on teardown", () => {
		const storage = createBrowserProfileStorage(() => "must-not-be-used");
		const first = storage.partitionFor("persistent");
		const second = storage.partitionFor("persistent");

		expect(first).toBe(AO_BROWSER_PERSISTENT_PARTITION);
		expect(second).toBe(AO_BROWSER_PERSISTENT_PARTITION);
		expect(storage.isPersistentDestinationActive()).toBe(true);

		storage.releasePartition(first);
		expect(storage.isPersistentDestinationActive()).toBe(true);
		storage.releasePartition(second);
		storage.releasePartition(second);
		expect(storage.isPersistentDestinationActive()).toBe(false);
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
});
