import { beforeEach, describe, expect, it, vi } from "vitest";

describe("ui-store terminal bar layouts", () => {
	beforeEach(() => {
		window.localStorage.clear();
		vi.resetModules();
	});

	it("keeps terminal layout state per owner without persisting it", async () => {
		const { useUiStore } = await import("./ui-store");
		const actions = useUiStore.getState();

		actions.activateTerminalTab("owner", "session:owner");
		actions.activateTerminalTab("owner", "shell:shell-b");
		actions.setTerminalTabPinned("owner", "shell:shell-b", true);

		expect(useUiStore.getState().terminalBarsByOwner.owner).toEqual({
			pinned: ["shell:shell-b"],
			unpinned: [],
			history: ["session:owner", "shell:shell-b"],
		});
		expect(window.localStorage.getItem("ao.terminalBars")).toBeNull();
	});
});
