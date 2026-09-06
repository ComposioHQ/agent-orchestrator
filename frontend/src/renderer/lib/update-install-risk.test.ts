import { describe, expect, it } from "vitest";
import { sessionsAtRiskFromInstall, type UpdateRiskSession } from "./update-install-risk";

function session(overrides: Partial<UpdateRiskSession> = {}): UpdateRiskSession {
	return {
		id: "s1",
		title: "Session",
		workspaceName: "repo",
		provider: "claude-code",
		mode: "chat",
		status: "working",
		...overrides,
	};
}

describe("sessionsAtRiskFromInstall", () => {
	it("flags a working chat session on a daemon-owned driver", () => {
		expect(sessionsAtRiskFromInstall([session()])).toHaveLength(1);
	});

	it("treats no_signal as possibly mid-turn", () => {
		expect(sessionsAtRiskFromInstall([session({ status: "no_signal" })])).toHaveLength(1);
	});

	it("spares TUI sessions, whose runtime is detached and re-adopted", () => {
		expect(sessionsAtRiskFromInstall([session({ mode: "tui" })])).toEqual([]);
	});

	it("spares Codex chat, which runs in a detached per-session host", () => {
		expect(sessionsAtRiskFromInstall([session({ provider: "codex" })])).toEqual([]);
	});

	it("spares sessions with no turn in flight", () => {
		for (const status of ["idle", "needs_input", "exited", "merged", "pr_open"]) {
			expect(sessionsAtRiskFromInstall([session({ status })])).toEqual([]);
		}
	});

	it("spares terminated sessions", () => {
		expect(sessionsAtRiskFromInstall([session({ isTerminated: true })])).toEqual([]);
	});
});
