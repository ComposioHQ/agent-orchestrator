import { beforeEach, describe, expect, it, vi } from "vitest";

describe("ui-store session terminal tabs", () => {
	beforeEach(() => {
		window.localStorage.clear();
		vi.resetModules();
	});

	it("adds unique non-owner tabs in order and removes only the requested tab", async () => {
		const { useUiStore } = await import("./ui-store");

		useUiStore.getState().addSessionTab("owner", "owner");
		useUiStore.getState().addSessionTab("owner", "worker-b");
		useUiStore.getState().addSessionTab("owner", "worker-c");
		useUiStore.getState().addSessionTab("owner", "worker-b");

		expect(useUiStore.getState().sessionTabsByOwner).toEqual({
			owner: ["worker-b", "worker-c"],
		});
		useUiStore.getState().removeSessionTab("owner", "worker-b");
		expect(useUiStore.getState().sessionTabsByOwner).toEqual({ owner: ["worker-c"] });
		expect(window.localStorage.getItem("ao.sessionTabs")).toBeNull();
	});
});
