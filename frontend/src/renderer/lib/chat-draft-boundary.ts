export type ChatDraftBoundaryKind =
	| "pending-attachments"
	| "pending-delivery"
	| "persistence-failed";
export type ChatDraftBoundarySource = "composer" | "inline-edit";

const boundaries = new Map<string, Map<ChatDraftBoundarySource, ChatDraftBoundaryKind>>();
const listeners = new Set<() => void>();

export const CHAT_DRAFT_BOUNDARY_COPY: Record<ChatDraftBoundaryKind, string> = {
	"pending-attachments":
		"Attachments are still being saved. Leaving now will discard any files AO has not finished writing to the worktree. Wait for saving to finish.",
	"pending-delivery":
		"A Chat delivery outcome is still unresolved. Its recovery ID is saved, but finish or explicitly retry recovery before leaving this chat.",
	"persistence-failed":
		"This Chat draft could not be saved locally. Leaving now will discard the unsaved changes. Copy the draft before leaving.",
};

function emitBoundaryChange(): void {
	for (const listener of listeners) listener();
}

export function setChatDraftBoundary(
	sessionId: string,
	source: ChatDraftBoundarySource,
	kind: ChatDraftBoundaryKind | undefined,
): void {
	if (!sessionId) return;
	const sessionBoundaries = boundaries.get(sessionId);
	if (!kind) {
		if (!sessionBoundaries?.delete(source)) return;
		if (sessionBoundaries.size === 0) boundaries.delete(sessionId);
		emitBoundaryChange();
		return;
	}
	if (sessionBoundaries?.get(source) === kind) return;
	const next = sessionBoundaries ?? new Map<ChatDraftBoundarySource, ChatDraftBoundaryKind>();
	next.set(source, kind);
	boundaries.set(sessionId, next);
	emitBoundaryChange();
}

export function getChatDraftBoundary(sessionId: string): ChatDraftBoundaryKind | undefined {
	const sessionBoundaries = boundaries.get(sessionId);
	if (!sessionBoundaries) return undefined;
	// A known failed write is more serious than an in-flight write and provides
	// the more accurate discard copy when both composer slices are unsafe.
	for (const kind of sessionBoundaries.values()) {
		if (kind === "persistence-failed") return kind;
	}
	return sessionBoundaries.values().next().value;
}

export function subscribeChatDraftBoundaries(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function confirmDiscardChatDraft(
	kind: ChatDraftBoundaryKind,
	confirm: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
	return confirm(`${CHAT_DRAFT_BOUNDARY_COPY[kind]}\n\nLeave this chat anyway?`);
}
