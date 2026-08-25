import { describe, expect, it, vi } from "vitest";

import {
	CHAT_DRAFT_BOUNDARY_COPY,
	confirmDiscardChatDraft,
	confirmDiscardChatDrafts,
	getChatDraftBoundary,
	getChatDraftBoundaries,
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

	it("preserves every active risk kind for mixed boundary decisions", () => {
		setChatDraftBoundary("session-mixed", "inline-edit", "pending-delivery");
		setChatDraftBoundary("session-mixed", "composer", "pending-attachments");

		expect(getChatDraftBoundaries("session-mixed")).toEqual([
			"pending-delivery",
			"pending-attachments",
		]);

		setChatDraftBoundary("session-mixed", "inline-edit", undefined);
		setChatDraftBoundary("session-mixed", "composer", undefined);
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

	it("describes every active risk before a mixed discard", () => {
		const confirm = vi.fn((_message: string) => true);
		expect(
			confirmDiscardChatDrafts(["pending-delivery", "pending-attachments"], confirm),
		).toBe(true);
		const warning = confirm.mock.calls[0]?.[0];
		expect(warning).toContain(CHAT_DRAFT_BOUNDARY_COPY["pending-delivery"]);
		expect(warning).toContain(CHAT_DRAFT_BOUNDARY_COPY["pending-attachments"]);
	});
});
