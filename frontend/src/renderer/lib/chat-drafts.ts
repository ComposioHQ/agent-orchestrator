import type { ConversationContentSummary } from "../types/conversation";

/**
 * Renderer-owned, session-scoped Chat drafts.
 *
 * Electron pins this origin's storage beneath AO's userData directory, so a
 * synchronous localStorage write survives Chat surface teardown, renderer
 * reload, and a supported app restart without putting daemon state in the UI.
 * Attachment bytes are deliberately absent: a descriptor is written only after
 * the daemon has durably staged those bytes in the session worktree.
 */

export const CHAT_DRAFT_SCHEMA_VERSION = 1 as const;

export interface ChatDraftAttachment {
	id: string;
	path: string;
	name: string;
	mimeType: string;
	bytes: number;
}

export interface ChatDraftInlineEdit {
	/** Changes whenever the inline edit changes. Used for accepted-edit CAS. */
	revision: string;
	turnId: string;
	text: string;
	content: ConversationContentSummary[];
}

export type ChatDraftDeliveryState = "dispatching" | "accepted";

export interface ChatComposerDelivery {
	kind: "send" | "steer";
	state: ChatDraftDeliveryState;
	/** Exact composer revision this delivery was created from. */
	revision: number;
	/** Stable daemon idempotency key. Reused for every recovery attempt. */
	clientMessageId: string;
	/** Exact API text, including durable attachment path references. */
	requestText: string;
}

export interface ChatInlineEditDelivery {
	kind: "inline-edit";
	state: ChatDraftDeliveryState;
	/** Exact inline-edit revision this delivery was created from. */
	revision: string;
	clientMessageId: string;
	turnId: string;
	requestText: string;
}

export type ChatDraftInlineEditInput = Omit<ChatDraftInlineEdit, "revision">;

export interface ChatSessionDraft {
	schemaVersion: typeof CHAT_DRAFT_SCHEMA_VERSION;
	sessionId: string;
	composer: {
		/** Changes whenever text or attachments change. Used for accepted-send CAS. */
		revision: number;
		text: string;
		attachments: ChatDraftAttachment[];
		/** Durable delivery journal. Present until acceptance is durably cleared. */
		delivery?: ChatComposerDelivery;
	};
	inlineEdit?: ChatDraftInlineEdit;
	/** Durable delivery journal for an inline branch edit. */
	inlineEditDelivery?: ChatInlineEditDelivery;
}

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type DraftWriteResult = { ok: true; draft: ChatSessionDraft } | { ok: false; draft: ChatSessionDraft };

export type DraftClearResult =
	| { ok: true; cleared: boolean; draft: ChatSessionDraft }
	| { ok: false; cleared: false; draft: ChatSessionDraft };

export type DraftDeliveryResult<Mutation> =
	| { ok: true; recovered: boolean; draft: ChatSessionDraft; mutation: Mutation }
	| { ok: false; recovered: boolean; draft: ChatSessionDraft; mutation?: Mutation };

export interface PrepareChatComposerDeliveryInput {
	kind: ChatComposerDelivery["kind"];
	composerText: string;
	attachments: ChatDraftAttachment[];
	requestText: string;
	clientMessageId: string;
}

export interface PrepareChatInlineEditDeliveryInput extends ChatDraftInlineEditInput {
	clientMessageId: string;
}

export type ChatDraftMutationToken = symbol;

export interface ChatDraftMutationSnapshot<Revision> {
	pending: boolean;
	accepted?: {
		sequence: number;
		revision: Revision;
		result: DraftClearResult;
	};
}

type DraftMutationKind = "composer" | "inline-edit";

type ChatDraftRuntime = {
	listeners: Set<() => void>;
	sequence: number;
	composerToken?: ChatDraftMutationToken;
	inlineEditToken?: ChatDraftMutationToken;
	composer: ChatDraftMutationSnapshot<number>;
	inlineEdit: ChatDraftMutationSnapshot<string>;
};

const EMPTY_COMPOSER_MUTATION: ChatDraftMutationSnapshot<number> = { pending: false };
const EMPTY_INLINE_EDIT_MUTATION: ChatDraftMutationSnapshot<string> = { pending: false };
const draftRuntimes = new Map<string, ChatDraftRuntime>();

function draftRuntime(sessionId: string): ChatDraftRuntime {
	let runtime = draftRuntimes.get(sessionId);
	if (!runtime) {
		runtime = {
			listeners: new Set(),
			sequence: 0,
			composer: EMPTY_COMPOSER_MUTATION,
			inlineEdit: EMPTY_INLINE_EDIT_MUTATION,
		};
		draftRuntimes.set(sessionId, runtime);
	}
	return runtime;
}

function emitDraftRuntime(runtime: ChatDraftRuntime): void {
	for (const listener of runtime.listeners) listener();
}

export function subscribeChatDraftRuntime(sessionId: string, listener: () => void): () => void {
	if (!sessionId) return () => undefined;
	const runtime = draftRuntime(sessionId);
	runtime.listeners.add(listener);
	return () => runtime.listeners.delete(listener);
}

export function getChatComposerMutation(
	sessionId: string,
): ChatDraftMutationSnapshot<number> {
	return draftRuntimes.get(sessionId)?.composer ?? EMPTY_COMPOSER_MUTATION;
}

export function getChatInlineEditMutation(
	sessionId: string,
): ChatDraftMutationSnapshot<string> {
	return draftRuntimes.get(sessionId)?.inlineEdit ?? EMPTY_INLINE_EDIT_MUTATION;
}

function beginDraftMutation(
	sessionId: string,
	kind: DraftMutationKind,
): ChatDraftMutationToken | undefined {
	if (!sessionId) return undefined;
	const runtime = draftRuntime(sessionId);
	if (kind === "composer") {
		if (runtime.composer.pending) return undefined;
		const token = Symbol("chat-composer-mutation");
		runtime.composerToken = token;
		runtime.composer = { pending: true };
		emitDraftRuntime(runtime);
		return token;
	}
	if (runtime.inlineEdit.pending) return undefined;
	const token = Symbol("chat-inline-edit-mutation");
	runtime.inlineEditToken = token;
	runtime.inlineEdit = { pending: true };
	emitDraftRuntime(runtime);
	return token;
}

export function beginChatComposerMutation(sessionId: string): ChatDraftMutationToken | undefined {
	return beginDraftMutation(sessionId, "composer");
}

export function beginChatInlineEditMutation(sessionId: string): ChatDraftMutationToken | undefined {
	return beginDraftMutation(sessionId, "inline-edit");
}

function cancelDraftMutation(
	sessionId: string,
	kind: DraftMutationKind,
	token: ChatDraftMutationToken,
): void {
	const runtime = draftRuntimes.get(sessionId);
	if (!runtime) return;
	if (kind === "composer") {
		if (runtime.composerToken !== token) return;
		runtime.composerToken = undefined;
		runtime.composer = EMPTY_COMPOSER_MUTATION;
	} else {
		if (runtime.inlineEditToken !== token) return;
		runtime.inlineEditToken = undefined;
		runtime.inlineEdit = EMPTY_INLINE_EDIT_MUTATION;
	}
	emitDraftRuntime(runtime);
}

export function cancelChatComposerMutation(
	sessionId: string,
	token: ChatDraftMutationToken,
): void {
	cancelDraftMutation(sessionId, "composer", token);
}

export function cancelChatInlineEditMutation(
	sessionId: string,
	token: ChatDraftMutationToken,
): void {
	cancelDraftMutation(sessionId, "inline-edit", token);
}

export function finishChatComposerMutation(
	sessionId: string,
	token: ChatDraftMutationToken,
	revision: number,
	result: DraftClearResult,
): void {
	const runtime = draftRuntimes.get(sessionId);
	if (!runtime || runtime.composerToken !== token) return;
	runtime.composerToken = undefined;
	runtime.sequence += 1;
	runtime.composer = {
		pending: false,
		accepted: { sequence: runtime.sequence, revision, result },
	};
	emitDraftRuntime(runtime);
}

export function finishChatInlineEditMutation(
	sessionId: string,
	token: ChatDraftMutationToken,
	revision: string,
	result: DraftClearResult,
): void {
	const runtime = draftRuntimes.get(sessionId);
	if (!runtime || runtime.inlineEditToken !== token) return;
	runtime.inlineEditToken = undefined;
	runtime.sequence += 1;
	runtime.inlineEdit = {
		pending: false,
		accepted: { sequence: runtime.sequence, revision, result },
	};
	emitDraftRuntime(runtime);
}

function invalidateAcceptedDraftMutation(sessionId: string, kind: DraftMutationKind): void {
	const runtime = draftRuntimes.get(sessionId);
	if (!runtime) return;
	if (kind === "composer") {
		if (!runtime.composer.accepted) return;
		runtime.composer = { pending: runtime.composer.pending };
	} else {
		if (!runtime.inlineEdit.accepted) return;
		runtime.inlineEdit = { pending: runtime.inlineEdit.pending };
	}
	emitDraftRuntime(runtime);
}

function storageKey(sessionId: string): string {
	// The key remains stable across schema versions so a future decoder can find
	// and migrate the prior record rather than orphaning it under a v1-only key.
	return `ao.chat.draft:${encodeURIComponent(sessionId)}`;
}

function rendererStorage(): DraftStorage | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

function emptyDraft(sessionId: string): ChatSessionDraft {
	return {
		schemaVersion: CHAT_DRAFT_SCHEMA_VERSION,
		sessionId,
		composer: { revision: 0, text: "", attachments: [] },
	};
}

function isContentSummary(value: unknown): value is ConversationContentSummary {
	if (!value || typeof value !== "object") return false;
	const content = value as Partial<ConversationContentSummary>;
	return (
		typeof content.type === "string" &&
		(content.mimeType === undefined || typeof content.mimeType === "string") &&
		(content.uri === undefined || typeof content.uri === "string") &&
		(content.name === undefined || typeof content.name === "string")
	);
}

function isAttachment(value: unknown): value is ChatDraftAttachment {
	if (!value || typeof value !== "object") return false;
	const attachment = value as Partial<ChatDraftAttachment>;
	return (
		typeof attachment.id === "string" &&
		attachment.id.length > 0 &&
		typeof attachment.path === "string" &&
		attachment.path.startsWith(".ao/attachments/") &&
		typeof attachment.name === "string" &&
		typeof attachment.mimeType === "string" &&
		typeof attachment.bytes === "number" &&
		Number.isFinite(attachment.bytes) &&
		attachment.bytes >= 0
	);
}

function isInlineEdit(value: unknown): value is ChatDraftInlineEdit {
	if (!value || typeof value !== "object") return false;
	const edit = value as Partial<ChatDraftInlineEdit>;
	return (
		typeof edit.revision === "string" &&
		edit.revision.length > 0 &&
		typeof edit.turnId === "string" &&
		edit.turnId.length > 0 &&
		typeof edit.text === "string" &&
		Array.isArray(edit.content) &&
		edit.content.every(isContentSummary)
	);
}

function isDeliveryState(value: unknown): value is ChatDraftDeliveryState {
	return value === "dispatching" || value === "accepted";
}

function isComposerDelivery(value: unknown): value is ChatComposerDelivery {
	if (!value || typeof value !== "object") return false;
	const delivery = value as Partial<ChatComposerDelivery>;
	return (
		(delivery.kind === "send" || delivery.kind === "steer") &&
		isDeliveryState(delivery.state) &&
		typeof delivery.revision === "number" &&
		Number.isInteger(delivery.revision) &&
		delivery.revision >= 0 &&
		typeof delivery.clientMessageId === "string" &&
		delivery.clientMessageId.length > 0 &&
		typeof delivery.requestText === "string"
	);
}

function isInlineEditDelivery(value: unknown): value is ChatInlineEditDelivery {
	if (!value || typeof value !== "object") return false;
	const delivery = value as Partial<ChatInlineEditDelivery>;
	return (
		delivery.kind === "inline-edit" &&
		isDeliveryState(delivery.state) &&
		typeof delivery.revision === "string" &&
		delivery.revision.length > 0 &&
		typeof delivery.clientMessageId === "string" &&
		delivery.clientMessageId.length > 0 &&
		typeof delivery.turnId === "string" &&
		delivery.turnId.length > 0 &&
		typeof delivery.requestText === "string"
	);
}

function inlineEditRevision(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isChatSessionDraft(value: unknown, sessionId: string): value is ChatSessionDraft {
	if (!value || typeof value !== "object") return false;
	const draft = value as Partial<ChatSessionDraft>;
	const composer = draft.composer as Partial<ChatSessionDraft["composer"]> | undefined;
	return (
		draft.schemaVersion === CHAT_DRAFT_SCHEMA_VERSION &&
		draft.sessionId === sessionId &&
		Boolean(composer) &&
		typeof composer?.revision === "number" &&
		Number.isInteger(composer.revision) &&
		composer.revision >= 0 &&
		typeof composer.text === "string" &&
		Array.isArray(composer.attachments) &&
		composer.attachments.every(isAttachment) &&
		(composer.delivery === undefined || isComposerDelivery(composer.delivery)) &&
		(draft.inlineEdit === undefined || isInlineEdit(draft.inlineEdit)) &&
		(draft.inlineEditDelivery === undefined || isInlineEditDelivery(draft.inlineEditDelivery))
	);
}

type DraftReadResult = { ok: true; draft: ChatSessionDraft } | { ok: false; draft: ChatSessionDraft };

function loadChatSessionDraft(sessionId: string, storage: DraftStorage | undefined): DraftReadResult {
	const empty = emptyDraft(sessionId);
	if (!sessionId || !storage) return { ok: false, draft: empty };
	let raw: string | null;
	try {
		raw = storage.getItem(storageKey(sessionId));
	} catch {
		return { ok: false, draft: empty };
	}
	if (!raw) return { ok: true, draft: empty };
	try {
		const parsed: unknown = JSON.parse(raw);
		return {
			ok: true,
			draft: isChatSessionDraft(parsed, sessionId) ? parsed : empty,
		};
	} catch {
		// Corrupt renderer data is recoverable. Treat it as an empty draft so the
		// next valid user edit can replace it; only an actual storage access failure
		// should fail closed and keep reporting that durability is unavailable.
		return { ok: true, draft: empty };
	}
}

export function readChatSessionDraft(
	sessionId: string,
	storage: DraftStorage | undefined = rendererStorage(),
): ChatSessionDraft {
	return loadChatSessionDraft(sessionId, storage).draft;
}

function hasContent(draft: ChatSessionDraft): boolean {
	return (
		draft.composer.text !== "" ||
		draft.composer.attachments.length > 0 ||
		Boolean(draft.composer.delivery) ||
		Boolean(draft.inlineEdit) ||
		Boolean(draft.inlineEditDelivery)
	);
}

function persistDraft(draft: ChatSessionDraft, storage: DraftStorage | undefined): DraftWriteResult {
	if (!draft.sessionId || !storage) return { ok: false, draft };
	try {
		if (hasContent(draft)) storage.setItem(storageKey(draft.sessionId), JSON.stringify(draft));
		else storage.removeItem(storageKey(draft.sessionId));
		return { ok: true, draft };
	} catch {
		return { ok: false, draft };
	}
}

/**
 * Persist and immediately read back the exact record. Dispatch callers use this
 * stronger boundary so a silent/no-op storage adapter cannot be mistaken for a
 * durable draft or idempotency key.
 */
function persistDraftProven(
	draft: ChatSessionDraft,
	storage: DraftStorage | undefined,
): DraftWriteResult {
	if (!draft.sessionId || !storage) return { ok: false, draft };
	const key = storageKey(draft.sessionId);
	try {
		if (hasContent(draft)) {
			const serialized = JSON.stringify(draft);
			storage.setItem(key, serialized);
			if (storage.getItem(key) !== serialized) return { ok: false, draft };
		} else {
			storage.removeItem(key);
			if (storage.getItem(key) !== null) return { ok: false, draft };
		}
		return { ok: true, draft };
	} catch {
		return { ok: false, draft };
	}
}

function attachmentsEqual(
	current: ChatDraftAttachment[],
	next: ChatDraftAttachment[],
): boolean {
	return (
		current.length === next.length &&
		current.every((attachment, index) => {
			const candidate = next[index];
			return (
				candidate !== undefined &&
				attachment.id === candidate.id &&
				attachment.path === candidate.path &&
				attachment.name === candidate.name &&
				attachment.mimeType === candidate.mimeType &&
				attachment.bytes === candidate.bytes
			);
		})
	);
}

/**
 * Atomically proves the exact composer snapshot and its stable delivery id
 * before the renderer is allowed to call the daemon.
 */
export function prepareChatComposerDelivery(
	sessionId: string,
	input: PrepareChatComposerDeliveryInput,
	storage: DraftStorage | undefined = rendererStorage(),
): DraftDeliveryResult<ChatComposerDelivery> {
	const loaded = loadChatSessionDraft(sessionId, storage);
	if (!loaded.ok) return { ok: false, recovered: false, draft: loaded.draft };
	const existing = loaded.draft.composer.delivery;
	if (existing) {
		const proof = persistDraftProven(loaded.draft, storage);
		return proof.ok
			? { ok: true, recovered: true, draft: proof.draft, mutation: existing }
			: { ok: false, recovered: true, draft: loaded.draft };
	}
	const exact =
		loaded.draft.composer.text === input.composerText &&
		attachmentsEqual(loaded.draft.composer.attachments, input.attachments);
	const revision = exact
		? loaded.draft.composer.revision
		: loaded.draft.composer.revision + 1;
	const mutation: ChatComposerDelivery = {
		kind: input.kind,
		state: "dispatching",
		revision,
		clientMessageId: input.clientMessageId,
		requestText: input.requestText,
	};
	const next: ChatSessionDraft = {
		...loaded.draft,
		composer: {
			revision,
			text: input.composerText,
			attachments: input.attachments,
			delivery: mutation,
		},
	};
	const result = persistDraftProven(next, storage);
	return result.ok
		? { ok: true, recovered: false, draft: result.draft, mutation }
		: { ok: false, recovered: false, draft: loaded.draft };
}

/** Persist the daemon's acceptance before attempting to remove the draft. */
export function markChatComposerDeliveryAccepted(
	sessionId: string,
	clientMessageId: string,
	revision: number,
	storage: DraftStorage | undefined = rendererStorage(),
): DraftWriteResult {
	const loaded = loadChatSessionDraft(sessionId, storage);
	const delivery = loaded.draft.composer.delivery;
	if (
		!loaded.ok ||
		!delivery ||
		delivery.clientMessageId !== clientMessageId ||
		delivery.revision !== revision
	) {
		return { ok: false, draft: loaded.draft };
	}
	if (delivery.state === "accepted") return { ok: true, draft: loaded.draft };
	const result = persistDraftProven(
		{
			...loaded.draft,
			composer: {
				...loaded.draft.composer,
				delivery: { ...delivery, state: "accepted" },
			},
		},
		storage,
	);
	return result.ok ? result : { ok: false, draft: loaded.draft };
}

/**
 * Remove a definitively refused steer journal without consuming its text. The
 * daemon proved that this guidance was not accepted, so the same composer
 * revision becomes an ordinary editable draft again.
 */
export function clearRejectedChatComposerDelivery(
	sessionId: string,
	clientMessageId: string,
	revision: number,
	storage: DraftStorage | undefined = rendererStorage(),
): DraftWriteResult {
	const loaded = loadChatSessionDraft(sessionId, storage);
	const delivery = loaded.draft.composer.delivery;
	if (
		!loaded.ok ||
		!delivery ||
		delivery.kind !== "steer" ||
		delivery.clientMessageId !== clientMessageId ||
		delivery.revision !== revision
	) {
		return { ok: false, draft: loaded.draft };
	}
	const next: ChatSessionDraft = {
		...loaded.draft,
		composer: {
			revision: loaded.draft.composer.revision,
			text: loaded.draft.composer.text,
			attachments: loaded.draft.composer.attachments,
		},
	};
	const result = persistDraftProven(next, storage);
	return result.ok ? result : { ok: false, draft: loaded.draft };
}

/**
 * Atomically proves an inline edit and its stable branch-mutation id before
 * dispatch. A restored journal is returned unchanged for explicit safe retry.
 */
export function prepareChatInlineEditDelivery(
	sessionId: string,
	input: PrepareChatInlineEditDeliveryInput,
	storage: DraftStorage | undefined = rendererStorage(),
): DraftDeliveryResult<ChatInlineEditDelivery> {
	const loaded = loadChatSessionDraft(sessionId, storage);
	if (!loaded.ok) return { ok: false, recovered: false, draft: loaded.draft };
	if (loaded.draft.inlineEditDelivery) {
		const proof = persistDraftProven(loaded.draft, storage);
		return proof.ok
			? {
					ok: true,
					recovered: true,
					draft: proof.draft,
					mutation: loaded.draft.inlineEditDelivery,
				}
			: { ok: false, recovered: true, draft: loaded.draft };
	}
	const current = loaded.draft.inlineEdit;
	const exact =
		current?.turnId === input.turnId &&
		current.text === input.text &&
		JSON.stringify(current.content) === JSON.stringify(input.content);
	const inlineEdit: ChatDraftInlineEdit = exact
		? current
		: {
				turnId: input.turnId,
				text: input.text,
				content: input.content,
				revision: inlineEditRevision(),
			};
	const mutation: ChatInlineEditDelivery = {
		kind: "inline-edit",
		state: "dispatching",
		revision: inlineEdit.revision,
		clientMessageId: input.clientMessageId,
		turnId: input.turnId,
		requestText: input.text,
	};
	const next: ChatSessionDraft = {
		...loaded.draft,
		inlineEdit,
		inlineEditDelivery: mutation,
	};
	const result = persistDraftProven(next, storage);
	return result.ok
		? { ok: true, recovered: false, draft: result.draft, mutation }
		: { ok: false, recovered: false, draft: loaded.draft };
}

export function markChatInlineEditDeliveryAccepted(
	sessionId: string,
	clientMessageId: string,
	revision: string,
	storage: DraftStorage | undefined = rendererStorage(),
): DraftWriteResult {
	const loaded = loadChatSessionDraft(sessionId, storage);
	const delivery = loaded.draft.inlineEditDelivery;
	if (
		!loaded.ok ||
		!delivery ||
		delivery.clientMessageId !== clientMessageId ||
		delivery.revision !== revision
	) {
		return { ok: false, draft: loaded.draft };
	}
	if (delivery.state === "accepted") return { ok: true, draft: loaded.draft };
	const result = persistDraftProven(
		{
			...loaded.draft,
			inlineEditDelivery: { ...delivery, state: "accepted" },
		},
		storage,
	);
	return result.ok ? result : { ok: false, draft: loaded.draft };
}

function mutateDraft(
	sessionId: string,
	mutate: (draft: ChatSessionDraft) => ChatSessionDraft,
	storage: DraftStorage | undefined,
	loaded: DraftReadResult = loadChatSessionDraft(sessionId, storage),
): DraftWriteResult {
	const next = mutate(loaded.draft);
	if (!loaded.ok) return { ok: false, draft: next };
	return persistDraft(next, storage);
}

export function writeChatComposerText(
	sessionId: string,
	text: string,
	storage: DraftStorage | undefined = rendererStorage(),
): DraftWriteResult {
	const loaded = loadChatSessionDraft(sessionId, storage);
	if (loaded.ok && loaded.draft.composer.text === text) {
		return { ok: true, draft: loaded.draft };
	}
	const result = mutateDraft(
		sessionId,
		(draft) => ({
			...draft,
			composer: {
				...draft.composer,
				revision: draft.composer.revision + 1,
				text,
			},
		}),
		storage,
		loaded,
	);
	if (result.ok) invalidateAcceptedDraftMutation(sessionId, "composer");
	return result;
}

export function writeChatAttachments(
	sessionId: string,
	attachments: ChatDraftAttachment[],
	storage: DraftStorage | undefined = rendererStorage(),
): DraftWriteResult {
	const loaded = loadChatSessionDraft(sessionId, storage);
	const current = loaded.draft;
	if (
		loaded.ok &&
		current.composer.attachments.length === attachments.length &&
		current.composer.attachments.every((attachment, index) => {
			const next = attachments[index];
			return (
				next !== undefined &&
				attachment.id === next.id &&
				attachment.path === next.path &&
				attachment.name === next.name &&
				attachment.mimeType === next.mimeType &&
				attachment.bytes === next.bytes
			);
		})
	) {
		return { ok: true, draft: current };
	}
	const result = mutateDraft(
		sessionId,
		(draft) => ({
			...draft,
			composer: {
				...draft.composer,
				revision: draft.composer.revision + 1,
				attachments,
			},
		}),
		storage,
		loaded,
	);
	if (result.ok) invalidateAcceptedDraftMutation(sessionId, "composer");
	return result;
}

export function writeChatInlineEdit(
	sessionId: string,
	inlineEdit: ChatDraftInlineEditInput | undefined,
	storage: DraftStorage | undefined = rendererStorage(),
): DraftWriteResult {
	const result = mutateDraft(
		sessionId,
		(draft) => {
			const next = { ...draft };
			if (inlineEdit) {
				next.inlineEdit = {
					...inlineEdit,
					revision: inlineEditRevision(),
				};
			} else delete next.inlineEdit;
			return next;
		},
		storage,
	);
	if (result.ok) invalidateAcceptedDraftMutation(sessionId, "inline-edit");
	return result;
}

/**
 * Clear an edit accepted by the daemon only if no later renderer has changed it.
 * This protects a remounted editor from a stale request completing afterward.
 */
export function clearAcceptedChatInlineEdit(
	sessionId: string,
	acceptedRevision: string,
	storage: DraftStorage | undefined = rendererStorage(),
): DraftClearResult {
	const loaded = loadChatSessionDraft(sessionId, storage);
	const current = loaded.draft;
	if (!loaded.ok) return { ok: false, cleared: false, draft: current };
	if (!current.inlineEdit || current.inlineEdit.revision !== acceptedRevision) {
		if (current.inlineEditDelivery?.revision !== acceptedRevision) {
			return { ok: true, cleared: false, draft: current };
		}
		const next = { ...current };
		delete next.inlineEditDelivery;
		const result = persistDraftProven(next, storage);
		return result.ok
			? { ok: true, cleared: false, draft: result.draft }
			: { ok: false, cleared: false, draft: current };
	}
	const next = { ...current };
	delete next.inlineEdit;
	delete next.inlineEditDelivery;
	const result = persistDraftProven(next, storage);
	return result.ok
		? { ok: true, cleared: true, draft: result.draft }
		: { ok: false, cleared: false, draft: current };
}

/**
 * Clear the composer accepted by the daemon only if it is still the same
 * revision. A keystroke or attachment change that happened while send awaited
 * acceptance must remain both on screen and in durable storage.
 */
export function clearAcceptedChatComposer(
	sessionId: string,
	acceptedRevision: number,
	storage: DraftStorage | undefined = rendererStorage(),
): DraftClearResult {
	const loaded = loadChatSessionDraft(sessionId, storage);
	const current = loaded.draft;
	if (!loaded.ok) return { ok: false, cleared: false, draft: current };
	if (current.composer.revision !== acceptedRevision) {
		if (current.composer.delivery?.revision !== acceptedRevision) {
			return { ok: true, cleared: false, draft: current };
		}
		const next: ChatSessionDraft = {
			...current,
			composer: {
				revision: current.composer.revision,
				text: current.composer.text,
				attachments: current.composer.attachments,
			},
		};
		const result = persistDraftProven(next, storage);
		return result.ok
			? { ok: true, cleared: false, draft: result.draft }
			: { ok: false, cleared: false, draft: current };
	}
	const next: ChatSessionDraft = {
		...current,
		composer: {
			revision: current.composer.revision + 1,
			text: "",
			attachments: [],
		},
	};
	const result = persistDraftProven(next, storage);
	return result.ok
		? { ok: true, cleared: true, draft: result.draft }
		: { ok: false, cleared: false, draft: current };
}
