export type ConversationEvent = {
	seq: number;
	projectId: string;
	sessionId?: string;
	type: string;
	event?: string;
	payload?: { conversationId?: string; [key: string]: unknown };
	createdAt: string;
};

// Control event the daemon emits when it snapped our replay cursor: durable
// payloads were skipped and every projection must refetch. Matches
// backend/internal/httpd/events.go eventsCursorResetEvent.
export const EVENTS_CURSOR_RESET = "events_cursor_reset";

export type ConversationCursorReset = {
	seq: number;
	type: typeof EVENTS_CURSOR_RESET;
	event: typeof EVENTS_CURSOR_RESET;
	sessionId?: undefined;
	payload?: undefined;
};

export type ConversationStreamEvent = ConversationEvent | ConversationCursorReset;

export const cursorResetEvent = (seq: number): ConversationCursorReset => ({
	seq,
	type: EVENTS_CURSOR_RESET,
	event: EVENTS_CURSOR_RESET,
});

export type ConversationEventRegistry = {
	subscribe(sessionId: string, listener: (event: ConversationStreamEvent) => void): () => void;
	publish(event: ConversationEvent): void;
	publishReset(cursor: number): void;
	/** Whether any session has a listener, i.e. whether payloads are worth parsing. */
	hasListeners(): boolean;
};

export function createConversationEventRegistry(): ConversationEventRegistry {
	const listeners = new Map<string, Set<(event: ConversationStreamEvent) => void>>();
	return {
		subscribe(sessionId, listener) {
			const sessionListeners = listeners.get(sessionId) ?? new Set();
			sessionListeners.add(listener);
			listeners.set(sessionId, sessionListeners);
			return () => {
				sessionListeners.delete(listener);
				if (sessionListeners.size === 0) listeners.delete(sessionId);
			};
		},
		hasListeners() {
			return listeners.size > 0;
		},
		publish(event) {
			if (!event.sessionId) return;
			for (const listener of listeners.get(event.sessionId) ?? []) listener(event);
		},
		// A cursor reset skipped payloads for every session, so fan the sentinel
		// out to all subscribers regardless of session routing.
		publishReset(cursor) {
			const event = cursorResetEvent(cursor);
			for (const sessionListeners of listeners.values()) {
				for (const listener of sessionListeners) listener(event);
			}
		},
	};
}

const CURSOR_PERSIST_DELAY_MS = 500;

/**
 * Events after which progress commits regardless of the debounce timer.
 *
 * The timer alone is not enough. A large cold-start replay keeps the JS thread
 * busy, and `setTimeout` is a macrotask — so under exactly the conditions where
 * saving progress matters most, the debounce never fires. A replay interrupted
 * before its first commit then restarts from the same cursor on the next launch,
 * forever. Counting events is immune to that, because it runs inline.
 */
export const CURSOR_PERSIST_EVENTS = 256;

export function createCursorPersister(persist: (cursor: number) => void | Promise<void>): {
	update(cursor: number): void;
	replace(cursor: number): void;
	flush(): void;
} {
	let latest = 0;
	let persisted = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let sinceCommit = 0;

	const save = (cursor: number) => {
		try {
			const result = persist(cursor);
			if (result) void result.catch(() => {});
		} catch {
			// Cursor persistence is an optimization. Durable replay remains authoritative.
		}
	};
	const commit = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		sinceCommit = 0;
		if (latest <= persisted) return;
		persisted = latest;
		save(latest);
	};

	return {
		update(cursor) {
			latest = Math.max(latest, cursor);
			// Whichever comes first: a quiet moment (the debounce) or enough events
			// that we refuse to risk losing the progress (the count).
			if (++sinceCommit >= CURSOR_PERSIST_EVENTS) {
				commit();
				return;
			}
			if (!timer) timer = setTimeout(commit, CURSOR_PERSIST_DELAY_MS);
		},
		replace(cursor) {
			if (timer) clearTimeout(timer);
			timer = undefined;
			sinceCommit = 0;
			latest = cursor;
			persisted = cursor;
			save(cursor);
		},
		flush() {
			commit();
		},
	};
}

/** Pull complete LF or CRLF SSE frames while preserving an incomplete tail. */
export function takeSseFrames(buffer: string): {
	frames: string[];
	remainder: string;
} {
	const frames: string[] = [];
	let remainder = buffer;
	let boundary = /\r?\n\r?\n/.exec(remainder);
	while (boundary) {
		frames.push(remainder.slice(0, boundary.index));
		remainder = remainder.slice(boundary.index + boundary[0].length);
		boundary = /\r?\n\r?\n/.exec(remainder);
	}
	return { frames, remainder };
}

/**
 * The frame's sequence from its `id:` line alone, without touching `data:`.
 *
 * Advancing the cursor is all a frame is worth when nothing is subscribed to its
 * session, and that is the common case: the app subscribes only to the chat it
 * currently has open. Parsing the payload anyway is what makes a large replay
 * expensive, so this is the cheap path.
 */
export function readSseFrameSeq(frame: string): number | undefined {
	for (const raw of frame.split("\n")) {
		if (!raw.startsWith("id:")) continue;
		const seq = Number(raw.slice(3).trim());
		return Number.isFinite(seq) ? seq : undefined;
	}
	return undefined;
}

export function parseSseFrame(frame: string): ConversationEvent | undefined {
	let id = 0;
	let eventName: string | undefined;
	const data: string[] = [];
	for (const raw of frame.replace(/\r/g, "").split("\n")) {
		if (raw.startsWith("id:")) id = Number(raw.slice(3).trim());
		else if (raw.startsWith("event:")) eventName = raw.slice(6).trim();
		else if (raw.startsWith("data:")) data.push(raw.slice(5).trimStart());
	}
	if (data.length === 0) return undefined;
	try {
		const event = JSON.parse(data.join("\n")) as ConversationEvent;
		if (!Number.isFinite(event.seq)) event.seq = id;
		if (eventName) event.event = eventName;
		return event;
	} catch {
		return undefined;
	}
}
