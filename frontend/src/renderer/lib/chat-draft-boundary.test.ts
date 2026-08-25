import { describe, expect, it, vi } from "vitest";

import {
	CHAT_DRAFT_BOUNDARY_COPY,
	confirmDiscardChatDraft,
	getChatDraftBoundary,
	setChatDraftBoundary,
	subscribeChatDraftBoundaries,
} from "./chat-draft-boundary";

describe("Chat draft destructive-boundary state", () => {
	it("isolates sessions and keeps another unsafe source when one clears", () => {
		setChatDraftBoundary("session-a", "composer", "pending-attachments");
		setChatDraftBoundary("session-a", "inline-edit", "persistence-failed");
		setChatDraftBoundary("session-b", "composer", "pending-attachments");

		expect(getChatDraftBoundary("session-a")).toBe("persistence-failed");
		setChatDraftBoundary("session-a", "inline-edit", undefined);
		expect(getChatDraftBoundary("session-a")).toBe("pending-attachments");
		expect(getChatDraftBoundary("session-b")).toBe("pending-attachments");

		setChatDraftBoundary("session-a", "composer", undefined);
		setChatDraftBoundary("session-b", "composer", undefined);
	});

	it("notifies subscribers only when the effective source state changes", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeChatDraftBoundaries(listener);
		setChatDraftBoundary("session-notify", "composer", "persistence-failed");
		setChatDraftBoundary("session-notify", "composer", "persistence-failed");
		setChatDraftBoundary("session-notify", "composer", undefined);
		unsubscribe();

		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("asks for explicit discard using precise copy", () => {
		const confirm = vi.fn(() => false);
		expect(confirmDiscardChatDraft("pending-attachments", confirm)).toBe(false);
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining(CHAT_DRAFT_BOUNDARY_COPY["pending-attachments"]));
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Leave this chat anyway?"));
	});
});
