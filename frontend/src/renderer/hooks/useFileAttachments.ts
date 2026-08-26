import { useCallback, useEffect, useRef, useState } from "react";
import { chatDraftScopeSessionId } from "../lib/chat-drafts";

// Client-side mirror of the backend spawn caps in
// backend/internal/httpd/controllers/sessions.go (maxAttachments /
// maxAttachmentBytes / maxAttachmentsBytes). Enforced here too so the user gets
// inline feedback at paste/drop time instead of a late rejection after submit.
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

export type FileAttachmentStatus = "reading" | "ready" | "failed";

/** A single file staged for a task/orchestrator brief. */
export type FileAttachment = {
	/** Stable id for list keys and removal. */
	id: string;
	/** Browser-reported MIME type (e.g. "image/png", "text/plain"). */
	mimeType: string;
	/** Decoded byte size (from File.size), used to enforce the total-size cap. */
	bytes: number;
	/** File name for display. */
	name: string;
	/** FileReader lifecycle. Failed entries stay in the draft for retry/removal. */
	status?: FileAttachmentStatus;
	/** data: URL used to render the thumbnail preview (for images only). */
	dataUrl?: string;
	/** Base64 payload without the "data:...;base64," prefix, for upload. */
	data?: string;
	/** Durable worktree-relative path, present only after daemon staging succeeds. */
	stagedPath?: string;
};

/** Attachment payload shape accepted by the spawn API. */
export type FileAttachmentPayload = {
	mimeType: string;
	data: string;
	name?: string;
};

export type FileAttachmentOptions = {
	/** Previously staged descriptors restored for this owning surface. */
	initialAttachments?: FileAttachment[];
	/** Changes when the hook must replace its state with initialAttachments. */
	initialKey?: string;
	/**
	 * Make newly read bytes durable before preparation settles. Reading and failed
	 * chips stay visible so the user can see, retry, or remove the exact file.
	 */
	prepareAttachments?: (attachments: FileAttachment[]) => Promise<FileAttachment[]>;
	/** Called after an accepted add, removal, or clear. */
	onAttachmentsChange?: (attachments: FileAttachment[]) => void;
};

type SharedAttachmentUpdate = {
	pending: number;
	attachments?: FileAttachment[];
	error?: string | null;
};

type SharedAttachmentEntry = {
	pending: Map<symbol, Set<string>>;
	generation: number;
	listeners: Map<symbol, (update: SharedAttachmentUpdate) => void>;
	attachments?: FileAttachment[];
	error?: string | null;
	sources: Map<string, File>;
};

type SharedAttachmentWork = { token: symbol; generation: number };

type CapturedPendingFileAttachmentEntry = {
	key: string;
	generation: number;
	tokens: readonly symbol[];
};

const pendingFileAttachmentCaptureEntries = Symbol("pending-file-attachment-capture");

/** Opaque handle for attachment work that was pending at a user-approved boundary. */
export type PendingFileAttachmentCapture = {
	readonly [pendingFileAttachmentCaptureEntries]: readonly CapturedPendingFileAttachmentEntry[];
};

function sharedAttachmentDescriptors(attachments: FileAttachment[]): FileAttachment[] {
	return attachments.map(({ id, mimeType, bytes, name, status, stagedPath }) => ({
		id,
		mimeType,
		bytes,
		name,
		status,
		...(stagedPath ? { stagedPath } : {}),
	}));
}

// Staging belongs to the AO session, not to one React mount. A controller or
// surface remount can happen while the daemon is writing bytes; keeping this
// tiny registry lets the replacement hook remain pending and receive the staged
// descriptors instead of restoring storage before the write and missing them.
const sharedAttachmentEntries = new Map<string, SharedAttachmentEntry>();

function sharedEntry(key: string): SharedAttachmentEntry {
	let entry = sharedAttachmentEntries.get(key);
	if (!entry) {
		entry = { pending: new Map(), generation: 0, listeners: new Map(), sources: new Map() };
		sharedAttachmentEntries.set(key, entry);
	}
	return entry;
}

function notifySharedAttachmentEntry(
	key: string,
	update: Omit<SharedAttachmentUpdate, "pending"> = {},
	originToken?: symbol,
): void {
	const entry = sharedAttachmentEntries.get(key);
	if (!entry) return;
	if (update.attachments !== undefined) entry.attachments = update.attachments;
	if (update.error !== undefined) entry.error = update.error;
	const notification = { pending: entry.pending.size, ...update };
	for (const [token, listener] of entry.listeners) {
		if (token !== originToken) listener(notification);
	}
}

function beginSharedAttachmentWork(key: string): SharedAttachmentWork {
	const entry = sharedEntry(key);
	const work = { token: Symbol("chat-attachment-work"), generation: entry.generation };
	entry.pending.set(work.token, new Set());
	notifySharedAttachmentEntry(key);
	return work;
}

function registerSharedAttachmentWorkIds(
	key: string,
	work: SharedAttachmentWork,
	ids: Iterable<string>,
): void {
	const entry = sharedAttachmentEntries.get(key);
	if (!entry || entry.generation !== work.generation) return;
	const owned = entry.pending.get(work.token);
	if (!owned) return;
	for (const id of ids) owned.add(id);
}

function discardSharedAttachmentTokens(
	entry: SharedAttachmentEntry,
	tokens: Iterable<symbol>,
): boolean {
	const discardedIds = new Set<string>();
	let changed = false;
	for (const token of tokens) {
		const owned = entry.pending.get(token);
		if (!owned) continue;
		for (const id of owned) discardedIds.add(id);
		entry.pending.delete(token);
		changed = true;
	}
	if (discardedIds.size > 0) {
		const stillOwned = new Set<string>();
		for (const owned of entry.pending.values()) {
			for (const id of owned) stillOwned.add(id);
		}
		const abandonedIds = new Set([...discardedIds].filter((id) => !stillOwned.has(id)));
		entry.attachments = entry.attachments?.filter(({ id }) => !abandonedIds.has(id)) ?? [];
		for (const id of abandonedIds) entry.sources.delete(id);
	}
	return changed;
}

function endSharedAttachmentWork(key: string, token: symbol): void {
	const entry = sharedAttachmentEntries.get(key);
	if (!entry) return;
	entry.pending.delete(token);
	notifySharedAttachmentEntry(key);
	if (
		entry.pending.size === 0 &&
		entry.listeners.size === 0 &&
		(entry.attachments?.length ?? 0) === 0 &&
		entry.sources.size === 0
	) {
		sharedAttachmentEntries.delete(key);
	}
}

function subscribeSharedAttachmentWork(
	key: string,
	token: symbol,
	listener: (update: SharedAttachmentUpdate) => void,
): () => void {
	const entry = sharedEntry(key);
	entry.listeners.set(token, listener);
	listener({
		pending: entry.pending.size,
		...(entry.attachments !== undefined ? { attachments: entry.attachments } : {}),
		...(entry.error !== undefined ? { error: entry.error } : {}),
	});
	return () => {
		entry.listeners.delete(token);
		if (
			entry.pending.size === 0 &&
			entry.listeners.size === 0 &&
			(entry.attachments?.length ?? 0) === 0 &&
			entry.sources.size === 0
		) {
			sharedAttachmentEntries.delete(key);
		}
	};
}

function sharedAttachmentPending(key: string | undefined): boolean {
	return Boolean(key && (sharedAttachmentEntries.get(key)?.pending.size ?? 0) > 0);
}

function sharedAttachmentWorkIsCurrent(key: string, work: SharedAttachmentWork): boolean {
	const entry = sharedAttachmentEntries.get(key);
	return Boolean(entry && entry.generation === work.generation && entry.pending.has(work.token));
}

export function discardPendingFileAttachments(key: string): void {
	const entry = sharedAttachmentEntries.get(key);
	if (!entry) return;
	entry.generation += 1;
	discardSharedAttachmentTokens(entry, [...entry.pending.keys()]);
	notifySharedAttachmentEntry(key, {
		attachments: entry.attachments ?? [],
		error: null,
	});
}

function attachmentKeyBelongsToSession(key: string, sessionId: string): boolean {
	return key === sessionId || chatDraftScopeSessionId(key) === sessionId;
}

/** Capture only the work that is pending when the user confirms leaving Chat. */
export function capturePendingFileAttachmentsForSession(
	sessionId: string,
): PendingFileAttachmentCapture {
	const entries: CapturedPendingFileAttachmentEntry[] = [];
	for (const [key, entry] of sharedAttachmentEntries) {
		if (!attachmentKeyBelongsToSession(key, sessionId) || entry.pending.size === 0) continue;
		entries.push({ key, generation: entry.generation, tokens: [...entry.pending.keys()] });
	}
	return { [pendingFileAttachmentCaptureEntries]: entries };
}

/**
 * Cancel exactly the pending work represented by a prior confirmation. Work
 * begun afterward remains current and can finish into the recoverable draft.
 */
export function discardCapturedPendingFileAttachments(
	capture: PendingFileAttachmentCapture,
): void {
	for (const captured of capture[pendingFileAttachmentCaptureEntries]) {
		const entry = sharedAttachmentEntries.get(captured.key);
		if (!entry || entry.generation !== captured.generation) continue;
		const changed = discardSharedAttachmentTokens(entry, captured.tokens);
		if (!changed) continue;
		notifySharedAttachmentEntry(captured.key, { attachments: entry.attachments ?? [] });
		if (
			entry.pending.size === 0 &&
			entry.listeners.size === 0 &&
			(entry.attachments?.length ?? 0) === 0 &&
			entry.sources.size === 0
		) {
			sharedAttachmentEntries.delete(captured.key);
		}
	}
}

/** Cancel every in-flight renderer generation owned by one logical AO session. */
export function discardPendingFileAttachmentsForSession(sessionId: string): void {
	for (const key of [...sharedAttachmentEntries.keys()]) {
		if (attachmentKeyBelongsToSession(key, sessionId)) discardPendingFileAttachments(key);
	}
}

/**
 * Remove only renderer descriptors/work for a deleted session incarnation. The
 * durable worktree bytes are intentionally outside this registry and untouched.
 */
export function purgeFileAttachmentsForSession(sessionId: string): void {
	for (const [key, entry] of [...sharedAttachmentEntries]) {
		if (!attachmentKeyBelongsToSession(key, sessionId)) continue;
		entry.generation += 1;
		entry.pending.clear();
		entry.sources.clear();
		notifySharedAttachmentEntry(key, { attachments: [], error: null });
		if (entry.listeners.size === 0) sharedAttachmentEntries.delete(key);
	}
}

// Client-side mirror of the backend image-preview allowlist. Non-image files can
// still be attached; they render with the generic file icon.
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp"]);

export const isSupportedImageAttachment = (type: string) =>
	SUPPORTED_IMAGE_TYPES.has(type.toLowerCase().trim());

const readFileAsBase64 = (file: File): Promise<{ dataUrl: string; data: string }> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
		reader.onload = () => {
			const dataUrl = typeof reader.result === "string" ? reader.result : "";
			const comma = dataUrl.indexOf(",");
			if (!dataUrl || comma < 0) {
				reject(new Error("Unreadable file data"));
				return;
			}
			resolve({
				dataUrl,
				data: dataUrl.slice(comma + 1),
			});
		};
		reader.readAsDataURL(file);
	});

/**
 * useFileAttachments stages files pasted, dropped, or picked into a brief and
 * exposes them as upload-ready payloads. Count and size caps (mirroring the backend)
 * are enforced here, and rejections / unreadable files surface through `error` for
 * inline feedback.
 *
 * Supports all file types except SVG (blocked for security). Images show thumbnails,
 * other files show a generic file icon.
 */
export function useFileAttachments(options: FileAttachmentOptions = {}) {
	const {
		initialAttachments = [],
		initialKey,
		prepareAttachments,
		onAttachmentsChange,
	} = options;
	const normalizeInitial = useCallback(
		(items: FileAttachment[]): FileAttachment[] =>
			items.map((attachment) => ({ ...attachment, status: attachment.status ?? "ready" })),
		[],
	);
	const [attachments, setAttachments] = useState<FileAttachment[]>(() =>
		normalizeInitial(initialAttachments),
	);
	const [validationError, setValidationError] = useState<string | null>(null);
	const [preparing, setPreparing] = useState(() => sharedAttachmentPending(initialKey));
	const attachmentsRef = useRef<FileAttachment[]>(normalizeInitial(initialAttachments));
	const initialKeyRef = useRef(initialKey);
	const listenerTokenRef = useRef(Symbol("file-attachment-listener"));
	const sourceFilesRef = useRef<Map<string, File>>(
		initialKey ? sharedEntry(initialKey).sources : new Map(),
	);
	const pendingReadsRef = useRef<Map<string, Promise<void>>>(new Map());
	const pendingRetriesRef = useRef<Set<Promise<boolean>>>(new Set());
	const addQueueRef = useRef<Promise<void>>(Promise.resolve());
	const queuedAddsRef = useRef(0);

	const commitAttachments = useCallback(
		(next: FileAttachment[]) => {
			attachmentsRef.current = next;
			setAttachments(next);
			onAttachmentsChange?.(next);
			if (initialKey) {
				notifySharedAttachmentEntry(
					initialKey,
					{ attachments: sharedAttachmentDescriptors(next) },
					listenerTokenRef.current,
				);
			}
		},
		[initialKey, onAttachmentsChange],
	);

	const commitError = useCallback(
		(next: string | null) => {
			setValidationError(next);
			if (initialKey) notifySharedAttachmentEntry(initialKey, { error: next });
		},
		[initialKey],
	);

	const updateAttachment = useCallback(
		(id: string, update: (attachment: FileAttachment) => FileAttachment) => {
			const index = attachmentsRef.current.findIndex((attachment) => attachment.id === id);
			if (index < 0) return;
			const next = [...attachmentsRef.current];
			next[index] = update(next[index]);
			commitAttachments(next);
		},
		[commitAttachments],
	);

	useEffect(() => {
		if (initialKeyRef.current === initialKey) return;
		initialKeyRef.current = initialKey;
		const restored = normalizeInitial(initialAttachments);
		attachmentsRef.current = restored;
		setAttachments(restored);
		sourceFilesRef.current = initialKey ? sharedEntry(initialKey).sources : new Map();
		setValidationError(null);
		setPreparing(sharedAttachmentPending(initialKey));
	}, [initialAttachments, initialKey, normalizeInitial]);

	useEffect(() => {
		if (!initialKey) return;
		return subscribeSharedAttachmentWork(initialKey, listenerTokenRef.current, (update) => {
			if (update.attachments) {
				const restored = normalizeInitial(update.attachments);
				attachmentsRef.current = restored;
				setAttachments(restored);
				onAttachmentsChange?.(restored);
			}
			if (update.error !== undefined) setValidationError(update.error);
			setPreparing(update.pending > 0);
		});
	}, [initialKey, normalizeInitial, onAttachmentsChange]);

	const readAttachment = useCallback(
		(id: string, file: File, sharedWork?: SharedAttachmentWork): Promise<void> => {
			let pending: Promise<void>;
			pending = readFileAsBase64(file)
				.then((result) => {
					if (
						initialKey &&
						sharedWork &&
						!sharedAttachmentWorkIsCurrent(initialKey, sharedWork)
					) {
						return;
					}
					const isImage = file.type.startsWith("image/") && isSupportedImageAttachment(file.type);
					updateAttachment(id, (attachment) => ({
						...attachment,
						status: "ready",
						dataUrl: isImage ? result.dataUrl : undefined,
						data: result.data,
					}));
				})
				.catch(() => {
					if (
						initialKey &&
						sharedWork &&
						!sharedAttachmentWorkIsCurrent(initialKey, sharedWork)
					) {
						return;
					}
					updateAttachment(id, (attachment) => ({
						...attachment,
						status: "failed",
						dataUrl: undefined,
						data: undefined,
						stagedPath: undefined,
					}));
				})
				.finally(() => {
					if (pendingReadsRef.current.get(id) === pending) pendingReadsRef.current.delete(id);
				});
			pendingReadsRef.current.set(id, pending);
			return pending;
		},
		[initialKey, updateAttachment],
	);

	const stageReadyAttachments = useCallback(
		async (ids?: ReadonlySet<string>, sharedWork?: SharedAttachmentWork): Promise<void> => {
			if (!prepareAttachments) return;
			if (initialKey && sharedWork && !sharedAttachmentWorkIsCurrent(initialKey, sharedWork)) return;
			const ready = attachmentsRef.current.filter(
				(attachment) =>
					(ids === undefined || ids.has(attachment.id)) &&
					attachment.status === "ready" &&
					!attachment.stagedPath &&
					attachment.data !== undefined,
			);
			if (ready.length === 0) return;
			const prepared = await prepareAttachments(ready);
			if (initialKey && sharedWork && !sharedAttachmentWorkIsCurrent(initialKey, sharedWork)) return;
			if (prepared.length !== ready.length) {
				throw new Error("Attachment staging returned an incomplete result");
			}
			const preparedByID = new Map(prepared.map((attachment) => [attachment.id, attachment]));
			commitAttachments(
				attachmentsRef.current.map((attachment) => preparedByID.get(attachment.id) ?? attachment),
			);
		},
		[commitAttachments, initialKey, prepareAttachments],
	);

	const processFiles = useCallback(async (files: File[], sharedWork?: SharedAttachmentWork) => {
		if (initialKey && sharedWork && !sharedAttachmentWorkIsCurrent(initialKey, sharedWork)) return;
		// Filter out directories - they have type "" and size 0 in most browsers
		const validFiles = files.filter((file) => {
			// Exclude directories (they typically have no type and size 0)
			// Also exclude items that might be folders based on common patterns
			if (file.type === "" && file.name.endsWith("/")) return false;
			// Some browsers report directories as size 0 with empty type
			if (file.type === "" && file.size === 0) return false;
			return true;
		});

		if (validFiles.length === 0) return;

		const errors = new Set<string>();
		// Block SVG files for security (active content)
		const blockedFiles = validFiles.filter(
			(file) => file.type.toLowerCase().trim() === "image/svg+xml",
		);
		if (blockedFiles.length > 0) {
			errors.add("SVG files are not supported for security reasons.");
		}
		const valid = validFiles.filter(
			(file) => file.type.toLowerCase().trim() !== "image/svg+xml",
		);

		// Reject oversized files before the (async) read.
		const readable = valid.filter((file) => {
			if (file.size > MAX_ATTACHMENT_BYTES) {
				errors.add(`Each file must be under ${mb(MAX_ATTACHMENT_BYTES)} MB.`);
				return false;
			}
			return true;
		});

		const accepted = [...attachmentsRef.current];
		let total = accepted.reduce((sum, attachment) => sum + attachment.bytes, 0);
		const fresh: Array<{ attachment: FileAttachment; file: File }> = [];
		for (const file of readable) {
			if (accepted.length + fresh.length >= MAX_ATTACHMENTS) {
				errors.add(`You can attach up to ${MAX_ATTACHMENTS} files.`);
				break;
			}
			if (total + file.size > MAX_ATTACHMENTS_BYTES) {
				// Only this file is refused: the remaining budget cannot absorb it,
				// but a later file in the same batch still can.
				errors.add(`Attachments must total under ${mb(MAX_ATTACHMENTS_BYTES)} MB.`);
				continue;
			}
			const id =
				typeof crypto !== "undefined" && "randomUUID" in crypto
					? crypto.randomUUID()
					: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
			const attachment: FileAttachment = {
				id,
				mimeType: file.type || "application/octet-stream",
				bytes: file.size,
				name: file.name,
				status: "reading",
			};
			fresh.push({ attachment, file });
			sourceFilesRef.current.set(id, file);
			if (initialKey) sharedEntry(initialKey).sources.set(id, file);
			total += file.size;
		}
		if (fresh.length > 0) {
			if (initialKey && sharedWork) {
				registerSharedAttachmentWorkIds(
					initialKey,
					sharedWork,
					fresh.map(({ attachment }) => attachment.id),
				);
			}
			commitAttachments([...accepted, ...fresh.map(({ attachment }) => attachment)]);
		}
		commitError(errors.size > 0 ? Array.from(errors).join(" ") : null);
		await Promise.all(
			fresh.map(({ attachment, file }) => readAttachment(attachment.id, file, sharedWork)),
		);
		if (initialKey && sharedWork && !sharedAttachmentWorkIsCurrent(initialKey, sharedWork)) return;
		try {
			await stageReadyAttachments(
				new Set(fresh.map(({ attachment }) => attachment.id)),
				sharedWork,
			);
		} catch {
			if (initialKey && sharedWork && !sharedAttachmentWorkIsCurrent(initialKey, sharedWork)) return;
			commitError("Files couldn’t be saved. Retry sending to save them again.");
		}
	}, [commitAttachments, commitError, initialKey, readAttachment, stageReadyAttachments]);

	const addFiles = useCallback((files: Iterable<File>): Promise<void> => {
		// Serialize batches. Two paste/drop events can arrive before React publishes
		// `preparing`; processing both against the same attachment snapshot could
		// otherwise exceed count/byte caps or overwrite one batch with the other.
		const batch = Array.from(files);
		if (batch.length === 0) return Promise.resolve();
		const sharedKey = initialKey;
		const sharedWork = sharedKey ? beginSharedAttachmentWork(sharedKey) : undefined;
		queuedAddsRef.current += 1;
		setPreparing(true);
		// Preserve the hook's existing contract: the first FileReader starts in the
		// same turn as addFiles. Only a later overlapping batch needs to wait for the
		// current queue, otherwise callers cannot observe the pending read immediately.
		const run =
			queuedAddsRef.current === 1
				? processFiles(batch, sharedWork)
				: addQueueRef.current.then(() => processFiles(batch, sharedWork));
		const settled = run
			.catch(() => {
				commitError("Some files couldn’t be prepared and were skipped.");
			})
			.finally(() => {
				queuedAddsRef.current = Math.max(0, queuedAddsRef.current - 1);
				if (sharedKey && sharedWork) endSharedAttachmentWork(sharedKey, sharedWork.token);
				else if (queuedAddsRef.current === 0 && pendingRetriesRef.current.size === 0) {
					setPreparing(false);
				}
			});
		addQueueRef.current = settled;
		return settled;
	}, [commitError, initialKey, processFiles]);

	const performRetry = useCallback(
		async (id: string): Promise<boolean> => {
			const file = sourceFilesRef.current.get(id);
			if (!file) return false;
			const existing = pendingReadsRef.current.get(id);
			if (existing) {
				await existing;
				const current = attachmentsRef.current.find((attachment) => attachment.id === id);
				return Boolean(current?.status === "ready" && (!prepareAttachments || current.stagedPath));
			}
			const sharedKey = initialKey;
			const sharedWork = sharedKey ? beginSharedAttachmentWork(sharedKey) : undefined;
			if (sharedKey && sharedWork) registerSharedAttachmentWorkIds(sharedKey, sharedWork, [id]);
			setPreparing(true);
			commitError(null);
			updateAttachment(id, (attachment) => ({
				...attachment,
				status: "reading",
				dataUrl: undefined,
				data: undefined,
				stagedPath: undefined,
			}));
			try {
				await readAttachment(id, file, sharedWork);
				if (sharedKey && sharedWork && !sharedAttachmentWorkIsCurrent(sharedKey, sharedWork)) {
					return false;
				}
				if (attachmentsRef.current.find((attachment) => attachment.id === id)?.status === "ready") {
					try {
						await stageReadyAttachments(new Set([id]), sharedWork);
					} catch {
						commitError("Files couldn’t be saved. Retry sending to save them again.");
					}
				}
				const current = attachmentsRef.current.find((attachment) => attachment.id === id);
				return Boolean(current?.status === "ready" && (!prepareAttachments || current.stagedPath));
			} finally {
				if (sharedKey && sharedWork) endSharedAttachmentWork(sharedKey, sharedWork.token);
			}
		},
		[
			commitError,
			initialKey,
			prepareAttachments,
			readAttachment,
			stageReadyAttachments,
			updateAttachment,
		],
	);
	const retry = useCallback(
		(id: string): Promise<boolean> => {
			let pending: Promise<boolean>;
			pending = performRetry(id).finally(() => {
				pendingRetriesRef.current.delete(pending);
				if (!initialKey && queuedAddsRef.current === 0 && pendingRetriesRef.current.size === 0) {
					setPreparing(false);
				}
			});
			pendingRetriesRef.current.add(pending);
			return pending;
		},
		[initialKey, performRetry],
	);

	const remove = useCallback((id: string) => {
		const next = attachmentsRef.current.filter((a) => a.id !== id);
		sourceFilesRef.current.delete(id);
		pendingReadsRef.current.delete(id);
		if (initialKey) sharedEntry(initialKey).sources.delete(id);
		commitAttachments(next);
		commitError(null);
	}, [commitAttachments, commitError, initialKey]);

	const clear = useCallback(() => {
		sourceFilesRef.current.clear();
		pendingReadsRef.current.clear();
		if (initialKey) sharedEntry(initialKey).sources.clear();
		commitAttachments([]);
		commitError(null);
	}, [commitAttachments, commitError, initialKey]);

	const payloadsFor = useCallback(
		(current: FileAttachment[]): FileAttachmentPayload[] =>
			current.flatMap(({ mimeType, data, name, status }) =>
				status === "ready" && data !== undefined ? [{ mimeType, data, name }] : [],
			),
		[],
	);

	const reconcilePersistedAttachments = useCallback((persisted: FileAttachment[]) => {
		// A hidden React Activity renders before its effects subscribe. By the time it
		// reconnects, another same-scope surface may have accepted and cleared the
		// durable draft. Prefer a live shared descriptor snapshot when one exists (it
		// owns pending work and failed-persistence recovery); otherwise re-seed from
		// storage at the commit boundary instead of reviving render-time descriptors.
		const shared = initialKey
			? sharedAttachmentEntries.get(initialKey)?.attachments
			: undefined;
		const next = shared ?? persisted;
		attachmentsRef.current = next;
		setAttachments(next);
	}, [initialKey]);

	const toPayload = useCallback(
		(): FileAttachmentPayload[] => payloadsFor(attachments),
		[attachments, payloadsFor],
	);

	const toSettledPayload = useCallback(async (): Promise<FileAttachmentPayload[]> => {
		while (queuedAddsRef.current > 0) {
			const queued = addQueueRef.current;
			await queued;
			if (queued === addQueueRef.current && queuedAddsRef.current === 0) break;
		}
		while (pendingReadsRef.current.size > 0) {
			await Promise.allSettled(Array.from(pendingReadsRef.current.values()));
		}
		while (pendingRetriesRef.current.size > 0) {
			const pending = [...pendingRetriesRef.current];
			await Promise.allSettled(pending);
			if (pendingRetriesRef.current.size === 0) break;
		}
		const currentBeforeStage = attachmentsRef.current;
		if (currentBeforeStage.some(({ status }) => status === "failed")) {
			throw new Error("Some files couldn't be read. Retry or remove them before sending.");
		}
		if (currentBeforeStage.some(({ status }) => status !== "ready")) {
			throw new Error("Some files are still being read. Wait before sending.");
		}
		if (prepareAttachments && currentBeforeStage.some(({ stagedPath }) => !stagedPath)) {
			const sharedKey = initialKey;
			const sharedWork = sharedKey ? beginSharedAttachmentWork(sharedKey) : undefined;
			if (sharedKey && sharedWork) {
				registerSharedAttachmentWorkIds(
					sharedKey,
					sharedWork,
					currentBeforeStage.filter(({ stagedPath }) => !stagedPath).map(({ id }) => id),
				);
			}
			setPreparing(true);
			try {
				await stageReadyAttachments(undefined, sharedWork);
				commitError(null);
			} catch {
				const message = "The files could not be attached. Nothing was sent.";
				commitError(message);
				throw new Error(message);
			} finally {
				if (sharedKey && sharedWork) endSharedAttachmentWork(sharedKey, sharedWork.token);
				else {
					setPreparing(queuedAddsRef.current > 0 || pendingRetriesRef.current.size > 0);
				}
			}
		}
		if (prepareAttachments && attachmentsRef.current.some(({ stagedPath }) => !stagedPath)) {
			throw new Error("The files are not durably available. Nothing was sent.");
		}
		return payloadsFor(attachmentsRef.current);
	}, [commitError, initialKey, payloadsFor, prepareAttachments, stageReadyAttachments]);

	const hasAttachments = useCallback(() => attachmentsRef.current.length > 0, []);
	const currentAttachments = useCallback(() => attachmentsRef.current, []);
	const signature = useCallback(
		() => attachmentsRef.current.map((attachment) => attachment.id).join(":"),
		[],
	);
	const hasUndurableAttachments = attachments.some(({ stagedPath }) => !stagedPath);
	const failed = attachments.filter(({ status }) => status === "failed");
	const readError =
		failed.length === 0
			? null
			: failed.length === 1
				? `${failed[0].name} couldn't be read. Retry or remove it.`
				: `${failed.length} files couldn't be read. Retry or remove them.`;
	const error = readError ?? validationError;

	return {
		attachments,
		error,
		preparing,
		addFiles,
		retry,
		remove,
		clear,
		reconcilePersistedAttachments,
		toPayload,
		toSettledPayload,
		hasAttachments,
		currentAttachments,
		signature,
		hasUndurableAttachments,
	};
}
