import { beforeEach, describe, expect, it, vi } from "vitest";

describe("ui-store terminal bar layouts", () => {
	beforeEach(() => {
		window.localStorage.clear();
		vi.resetModules();
	});

	it("keeps ordered pin and MRU state in memory per owner", async () => {
		const { useUiStore } = await import("./ui-store");

		useUiStore.getState().addTerminalTab("owner", "shell:shell-b");
		useUiStore.getState().addTerminalTab("owner", "shell:shell-c");
		useUiStore.getState().activateTerminalTab("owner", "session:owner");
		useUiStore.getState().activateTerminalTab("owner", "shell:shell-b");
		useUiStore.getState().setTerminalTabPinned("owner", "shell:shell-b", true);

		expect(useUiStore.getState().terminalBarsByOwner).toEqual({
			owner: {
				pinned: ["shell:shell-b"],
				unpinned: ["shell:shell-c"],
				history: ["session:owner", "shell:shell-b"],
			},
		});

		const next = useUiStore
			.getState()
			.closeTerminalTab("owner", "shell:shell-b", [
				"session:owner",
				"shell:shell-b",
				"shell:shell-c",
			]);
		expect(next).toBe("session:owner");
		expect(useUiStore.getState().terminalBarsByOwner.owner).toEqual({
			pinned: [],
			unpinned: ["shell:shell-c"],
			history: ["session:owner"],
		});
		expect(window.localStorage.getItem("ao.terminalBars")).toBeNull();
	});
});
