import { describe, expect, it, vi } from "vitest";

import {
	CHAT_DRAFT_UNLOAD_DIALOG,
	confirmUnsafeChatDraftLeave,
	shouldPreventUnsafeChatDraftClose,
} from "./chat-draft-unload";

describe("native Chat draft unload confirmation", () => {
	it("keeps the app open by default and only discards on the explicit second choice", () => {
		const stay = vi.fn(() => 0);
		const leave = vi.fn(() => 1);

		expect(confirmUnsafeChatDraftLeave(stay)).toBe(false);
		expect(confirmUnsafeChatDraftLeave(leave)).toBe(true);
		expect(stay).toHaveBeenCalledWith(CHAT_DRAFT_UNLOAD_DIALOG);
		expect(CHAT_DRAFT_UNLOAD_DIALOG).toMatchObject({
			defaultId: 0,
			cancelId: 0,
		});
		expect(CHAT_DRAFT_UNLOAD_DIALOG.detail).toContain("discard unsaved text or attachments");
		expect(CHAT_DRAFT_UNLOAD_DIALOG.detail).toContain("unresolved delivery recovery");
	});

	it("prevents the native window close until the user explicitly chooses to leave", () => {
		const stay = vi.fn(() => 0);
		const leave = vi.fn(() => 1);

		expect(shouldPreventUnsafeChatDraftClose(true, false, stay)).toBe(true);
		expect(shouldPreventUnsafeChatDraftClose(true, false, leave)).toBe(false);
		expect(shouldPreventUnsafeChatDraftClose(false, false, stay)).toBe(false);
		expect(shouldPreventUnsafeChatDraftClose(true, true, stay)).toBe(false);
		expect(stay).toHaveBeenCalledTimes(1);
	});
});
