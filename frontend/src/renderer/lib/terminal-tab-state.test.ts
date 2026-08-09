import { describe, expect, it } from "vitest";
import {
	activateTerminalTab,
	closeTerminalTab,
	emptyTerminalBarLayout,
	reorderTerminalTabs,
	resolveTerminalTabLayout,
	setTerminalTabPinned,
} from "./terminal-tab-state";

const owner = "session:owner" as const;
const shell = "shell:shell-1" as const;
const secondShell = "shell:shell-2" as const;
const thirdShell = "shell:shell-3" as const;
const reviewer = "reviewer:review-1" as const;

describe("terminal tab state", () => {
	it("derives native terminals while filtering stale layout and history entries", () => {
		const resolved = resolveTerminalTabLayout(
			{ pinned: [secondShell], unpinned: ["shell:stale"], history: [owner, "shell:stale", reviewer] },
			[owner, shell, secondShell, reviewer],
		);

		expect(resolved).toEqual({
			pinned: [secondShell],
			unpinned: [shell],
			history: [owner, reviewer],
		});
	});

	it("pins a derived terminal and restores it to the unpinned start", () => {
		const pinned = setTerminalTabPinned(emptyTerminalBarLayout(), shell, true);
		expect(pinned).toEqual({ pinned: [shell], unpinned: [], history: [] });

		expect(setTerminalTabPinned(pinned, shell, false)).toEqual({
			pinned: [],
			unpinned: [shell],
			history: [],
		});
	});

	it("stores a derived group order without crossing the pin boundary", () => {
		const layout = {
			pinned: [shell],
			unpinned: [],
			history: [],
		};

		expect(reorderTerminalTabs(layout, "unpinned", [thirdShell, shell, secondShell, thirdShell])).toEqual({
			pinned: [shell],
			unpinned: [thirdShell, secondShell],
			history: [],
		});
	});

	it("returns to the most recently active remaining card when a shell closes", () => {
		let layout = activateTerminalTab(emptyTerminalBarLayout(), owner);
		layout = activateTerminalTab(layout, reviewer);
		layout = activateTerminalTab(layout, shell);

		expect(closeTerminalTab(layout, shell, [owner, reviewer, shell], owner)).toEqual({
			layout: {
				pinned: [],
				unpinned: [],
				history: [owner, reviewer],
			},
			nextActiveKey: reviewer,
		});
		expect(closeTerminalTab(emptyTerminalBarLayout(), shell, [owner, shell], owner).nextActiveKey).toBe(owner);
	});
});
