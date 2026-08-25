import type { MessageBoxSyncOptions } from "electron";

export const CHAT_DRAFT_UNLOAD_DIALOG: MessageBoxSyncOptions = {
	type: "warning",
	title: "Unsaved Chat draft",
	message: "This Chat draft is not safely saved yet.",
	detail:
		"Leaving now can discard unsaved text or attachments that AO is still writing, or interrupt unresolved delivery recovery. Stay to copy the draft, wait for saving, or finish delivery recovery.",
	buttons: ["Stay", "Leave anyway"],
	defaultId: 0,
	cancelId: 0,
	noLink: true,
};

export function confirmUnsafeChatDraftLeave(showMessageBoxSync: (options: MessageBoxSyncOptions) => number): boolean {
	return showMessageBoxSync(CHAT_DRAFT_UNLOAD_DIALOG) === 1;
}

export function shouldPreventUnsafeChatDraftClose(
	riskActive: boolean,
	alreadyConfirmed: boolean,
	showMessageBoxSync: (options: MessageBoxSyncOptions) => number,
): boolean {
	if (!riskActive || alreadyConfirmed) return false;
	return !confirmUnsafeChatDraftLeave(showMessageBoxSync);
}
