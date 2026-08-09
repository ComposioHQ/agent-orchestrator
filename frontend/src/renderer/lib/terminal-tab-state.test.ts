import { describe, expect, it } from "vitest";
import {
	activateTerminalTab,
	addTerminalTab,
	closeTerminalTab,
	emptyTerminalBarLayout,
	reorderTerminalTabs,
	resolveTerminalTabLayout,
	setTerminalTabPinned,
	type TerminalBarLayout,
} from "./terminal-tab-state";

const owner = "session:owner" as const;
const second = "session:second" as const;
const shell = "shell:shell-1" as const;
const secondShell = "shell:shell-2" as const;
const thirdShell = "shell:shell-3" as const;
const reviewer = "reviewer:review-1" as const;

describe("terminal tab state", () => {
	it("adds native terminals once and ignores session and reviewer cards", () => {
		let layout = addTerminalTab(emptyTerminalBarLayout(), shell, owner);
		layout = addTerminalTab(layout, shell, owner);
		layout = addTerminalTab(layout, second, owner);
		layout = addTerminalTab(layout, owner, owner);
		layout = addTerminalTab(layout, reviewer, owner);

		expect(layout).toEqual({ pinned: [], unpinned: [shell], history: [] });
	});

	it("moves pinned tabs to the pinned end and unpinned tabs to the unpinned start", () => {
		const layout = { pinned: [], unpinned: [shell, secondShell], history: [] } satisfies TerminalBarLayout;
		const pinned = setTerminalTabPinned(layout, shell, true);
		expect(pinned).toEqual({ pinned: [shell], unpinned: [secondShell], history: [] });

		expect(setTerminalTabPinned(pinned, shell, false)).toEqual({
			pinned: [],
			unpinned: [shell, secondShell],
			history: [],
		});
	});

	it("reorders only known members of the requested group", () => {
		const layout = {
			pinned: [shell, secondShell],
			unpinned: [thirdShell],
			history: [],
		} satisfies TerminalBarLayout;

		expect(reorderTerminalTabs(layout, "pinned", [thirdShell, secondShell, secondShell, shell])).toEqual({
			pinned: [secondShell, shell],
			unpinned: [thirdShell],
			history: [],
		});
	});

	it("keeps terminal-bar activation history unique and most-recent-last", () => {
		let layout = activateTerminalTab(emptyTerminalBarLayout(), owner);
		layout = activateTerminalTab(layout, second);
		layout = activateTerminalTab(layout, shell);
		layout = activateTerminalTab(layout, second);

		expect(layout.history).toEqual([owner, shell, second]);
	});

	it("closes the active card into the most recently active remaining card", () => {
		const layout = {
			pinned: [secondShell],
			unpinned: [thirdShell, shell],
			history: [owner, thirdShell, second, reviewer, shell],
		} satisfies TerminalBarLayout;

		expect(closeTerminalTab(layout, shell, [owner, second, secondShell, thirdShell, reviewer, shell], owner)).toEqual({
			layout: {
				pinned: [secondShell],
				unpinned: [thirdShell],
				history: [owner, thirdShell, second, reviewer],
			},
			nextActiveKey: reviewer,
		});
	});

	it("closing an inactive card preserves the active card and filters stale keys", () => {
		const layout = {
			pinned: [secondShell],
			unpinned: [thirdShell, shell],
			history: [owner, "shell:stale", shell],
		} satisfies TerminalBarLayout;

		const resolved = resolveTerminalTabLayout(layout, [owner, thirdShell, shell, reviewer], owner);
		expect(resolved).toEqual({ pinned: [], unpinned: [thirdShell, shell], history: [owner, shell] });
		expect(closeTerminalTab(resolved, thirdShell, [owner, thirdShell, shell, reviewer], owner).nextActiveKey).toBe(shell);
	});
});
