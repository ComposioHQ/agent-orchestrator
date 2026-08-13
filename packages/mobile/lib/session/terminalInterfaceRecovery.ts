import type { SessionInterfaceTransition } from "../chat/api";

export type TerminalInterfaceFailureRecovery = {
	actionLabel: string;
	policy: "interrupt";
	confirmationTitle: string;
	confirmationMessage: string;
	confirmationAction: string;
	confirmStyle: "destructive";
};

const discardDraftRecovery: TerminalInterfaceFailureRecovery = {
	actionLabel: "Discard draft and switch",
	policy: "interrupt",
	confirmationTitle: "Discard draft and switch?",
	confirmationMessage:
		"Stopping now permanently discards the unsent terminal draft before switching to Chat. This cannot be undone. Completed conversation history and worktree files are preserved.",
	confirmationAction: "Discard draft and switch",
	confirmStyle: "destructive",
};

// Only a positively identified draft may advertise this destructive recovery.
// Other failures need their own remediation and must not silently become Stop.
export function terminalInterfaceFailureRecovery(
	transition?: Pick<SessionInterfaceTransition, "errorCode">,
): TerminalInterfaceFailureRecovery | undefined {
	return transition?.errorCode === "DRAIN_DRAFT_PRESENT" ? discardDraftRecovery : undefined;
}
