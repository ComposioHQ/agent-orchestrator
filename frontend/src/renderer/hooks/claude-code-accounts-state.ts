import type { QueryClient } from "@tanstack/react-query";
import type { ClaudeCodeAccountSwitch, ClaudeCodeAccountsResponse } from "./useClaudeCodeAccountsQuery";

export const claudeCodeAccountsQueryKey = ["claude-code-accounts"] as const;

export function mergeClaudeCodeAccounts(
	current: ClaudeCodeAccountsResponse | undefined,
	incoming: ClaudeCodeAccountsResponse,
): ClaudeCodeAccountsResponse {
	if (current && incoming.accountRevision < current.accountRevision) return current;
	const accounts = incoming.accounts.map((account) => ({
		...account,
		active: account.id === incoming.activeAccountId,
	}));
	accounts.sort((left, right) => {
		if (left.active !== right.active) return left.active ? -1 : 1;
		return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
	});
	return { ...incoming, accounts };
}

export function writeClaudeCodeAccounts(queryClient: QueryClient, incoming: ClaudeCodeAccountsResponse): void {
	queryClient.setQueryData<ClaudeCodeAccountsResponse>(claudeCodeAccountsQueryKey, (current) =>
		mergeClaudeCodeAccounts(current, incoming));
}

const reasonKeys = {
	account_valid: "settings.claudeCodeAccounts.reason.accountValid",
	account_signed_out: "settings.claudeCodeAccounts.reason.accountSignedOut",
	account_broken: "settings.claudeCodeAccounts.reason.accountBroken",
	supported: "settings.claudeCodeAccounts.reason.supported",
	unsupported_platform: "settings.claudeCodeAccounts.reason.unsupportedPlatform",
	unsupported_version: "settings.claudeCodeAccounts.reason.unsupportedVersion",
	environment_auth_override: "settings.claudeCodeAccounts.reason.environmentAuthOverride",
	keychain_unavailable: "settings.claudeCodeAccounts.reason.keychainUnavailable",
	global_account_changed: "settings.claudeCodeAccounts.reason.globalAccountChanged",
	login_pending: "settings.claudeCodeAccounts.reason.loginPending",
	login_verifying: "settings.claudeCodeAccounts.reason.loginVerifying",
	login_completed: "settings.claudeCodeAccounts.reason.loginCompleted",
	login_cancelled: "settings.claudeCodeAccounts.reason.loginCancelled",
	login_failed: "settings.claudeCodeAccounts.reason.loginFailed",
	login_unauthorized: "settings.claudeCodeAccounts.reason.loginUnauthorized",
	login_unverified: "settings.claudeCodeAccounts.reason.loginUnverified",
	login_expired: "settings.claudeCodeAccounts.reason.loginExpired",
	identity_mismatch: "settings.claudeCodeAccounts.reason.identityMismatch",
	account_already_exists: "settings.claudeCodeAccounts.reason.accountAlreadyExists",
} as const;

export type ClaudeCodeAccountMessageKey = (typeof reasonKeys)[keyof typeof reasonKeys]
	| `settings.claudeCodeAccounts.switch.${ClaudeCodeAccountSwitch["phase"] | "unknown"}`;

export function claudeCodeAccountReasonKey(reasonCode: string | null | undefined): ClaudeCodeAccountMessageKey {
	return reasonKeys[reasonCode as keyof typeof reasonKeys] ?? "settings.claudeCodeAccounts.switch.unknown";
}

export type ClaudeCodeSwitchDisplay = {
	key: ClaudeCodeAccountMessageKey;
	tone: "muted" | "warning" | "error";
	busy: boolean;
	canRecover: boolean;
};

export function claudeCodeSwitchDisplay(switchState: ClaudeCodeAccountSwitch): ClaudeCodeSwitchDisplay {
	const phase = switchState.phase;
	const terminal = phase === "completed" || phase === "failed" || phase === "rollback_required" || phase === "recovery_required";
	return {
		key: `settings.claudeCodeAccounts.switch.${phase}`,
		tone: phase === "failed" ? "error" : phase === "rollback_required" || phase === "recovery_required" ? "warning" : "muted",
		busy: !terminal,
		canRecover: switchState.canRecover && phase === "recovery_required",
	};
}
