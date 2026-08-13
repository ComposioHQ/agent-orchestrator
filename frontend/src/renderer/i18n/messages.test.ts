import { afterEach, describe, expect, it, vi } from "vitest";

describe("loadCatalog", () => {
	afterEach(() => {
		vi.doUnmock("./de.json");
		vi.resetModules();
	});

	it("retries a deferred catalog after an import failure", async () => {
		vi.doMock("./de.json", () => {
			throw new Error("locale chunk unavailable");
		});
		const { loadCatalog } = await import("./messages");

		const firstAttempt = loadCatalog("de");
		await expect(firstAttempt).rejects.toThrow();
		const retry = loadCatalog("de");
		await expect(retry).rejects.toThrow();

		expect(retry).not.toBe(firstAttempt);
	});
});
