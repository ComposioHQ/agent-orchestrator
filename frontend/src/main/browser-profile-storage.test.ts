import { describe, expect, it } from "vitest";
import {
	AO_BROWSER_PERSISTENT_PARTITION,
	createBrowserProfileStorage,
	type BrowserProfilePersistence,
} from "./browser-profile-storage";

describe("browser profile storage", () => {
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
	});
});
