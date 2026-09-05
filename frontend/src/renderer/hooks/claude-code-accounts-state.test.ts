import { describe, expect, it } from "vitest";
import type { ClaudeCodeAccountsResponse } from "./useClaudeCodeAccountsQuery";
import { claudeCodeSwitchDisplay, mergeClaudeCodeAccounts } from "./claude-code-accounts-state";

const capability = { state: "supported", reasonCode: "supported", reason: "Available." } as const;
const account = (id: string, createdAt: string, active = false) => ({ id, createdAt, updatedAt: createdAt, active });

function response(accounts: ReturnType<typeof account>[], activeAccountId = "a", revision = 7): ClaudeCodeAccountsResponse {
	return {
		accountRevision: revision,
		activeAccountId,
		accounts,
		capabilities: {
			accountRead: capability, nativeLogin: capability, accountManagement: capability,
			globalSwitch: capability, hotReload: capability, sessionExitResume: { ...capability, state: "unsupported" },
		},
	} as ClaudeCodeAccountsResponse;
}

describe("mergeClaudeCodeAccounts", () => {
	it("keeps the current account active when an added account appears", () => {
		const merged = mergeClaudeCodeAccounts(response([account("a", "2026-09-01T00:00:00Z", true)]), response([
			account("a", "2026-09-01T00:00:00Z", true),
			account("b", "2026-09-02T00:00:00Z"),
		], "a", 7));
		expect(merged.accounts.map(({ id, active }) => [id, active])).toEqual([["a", true], ["b", false]]);
	});

	it("rejects stale account revisions", () => {
		const current = response([account("b", "2026-09-02T00:00:00Z", true)], "b", 8);
		expect(mergeClaudeCodeAccounts(current, response([account("a", "2026-09-01T00:00:00Z", true)], "a", 7))).toBe(current);
	});
});

it("presents hot-switch recovery as actionable and not busy", () => {
	const display = claudeCodeSwitchDisplay({ phase: "recovery_required", canRecover: true } as never);
	expect(display).toMatchObject({ busy: false, canRecover: true, tone: "warning" });
});

it("presents an orphaned in-progress switch as recoverable", () => {
	const display = claudeCodeSwitchDisplay({ phase: "verifying_target", canRecover: true } as never);
	expect(display).toMatchObject({
		key: "settings.claudeCodeAccounts.switch.recovery_required",
		busy: false,
		canRecover: true,
		tone: "warning",
	});
});
