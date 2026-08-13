import type { SessionInterfaceTransition } from "../chat/api";
import { Alert } from "react-native";

export type TerminalInterfaceFailureRecovery = {
	actionLabel: string;
	policy: "interrupt";
	confirmationTitle: string;
	confirmationMessage: string;
	confirmationAction: string;
	confirmStyle: "destructive";
	confirm: (onConfirm: (policy: "interrupt") => void) => void;
};

const discardDraftRecovery: TerminalInterfaceFailureRecovery = {
	actionLabel: "Discard draft and switch",
	policy: "interrupt",
	confirmationTitle: "Discard draft and switch?",
	confirmationMessage:
		"Stopping now permanently discards the unsent terminal draft before switching to Chat. This cannot be undone. Completed conversation history and worktree files are preserved.",
	confirmationAction: "Discard draft and switch",
	confirmStyle: "destructive",
	confirm: (onConfirm) => {
		Alert.alert(
			"Discard draft and switch?",
			"Stopping now permanently discards the unsent terminal draft before switching to Chat. This cannot be undone. Completed conversation history and worktree files are preserved.",
			[
				{ text: "Keep draft", style: "cancel" },
				{
					text: "Discard draft and switch",
					style: "destructive",
					onPress: () => onConfirm("interrupt"),
				},
			],
		);
	},
};

// Only a positively identified draft may advertise this destructive recovery.
// Other failures need their own remediation and must not silently become Stop.
export function terminalInterfaceFailureRecovery(
	transition?: Pick<SessionInterfaceTransition, "errorCode">,
): TerminalInterfaceFailureRecovery | undefined {
	return transition?.errorCode === "DRAIN_DRAFT_PRESENT" ? discardDraftRecovery : undefined;
}
