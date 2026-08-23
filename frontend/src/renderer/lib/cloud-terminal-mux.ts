// Terminal transport for cloud sessions.
//
// Implements the same TerminalMux interface the loopback daemon mux does, so
// TerminalPane, XtermTerminal, and the whole attachment lifecycle in
// useTerminalSession are shared verbatim between local and cloud sessions. Only
// the socket underneath differs:
//
//   local  ws://127.0.0.1:<daemon>/mux            (unauthenticated loopback)
//   cloud  wss://<control-plane>/api/cloud/v1/terminal?ticket=…&after=…&kind=…
//
// Authorization is a short-lived, session-scoped ticket minted per attach
// (POST …/sessions/{id}/terminal-ticket), never the AO access token: the token
// stays in Electron main, and a ticket that leaks into a URL expires in seconds
// and grants one session's terminal only.
//
// The wire framing mirrors the daemon's terminal protocol (see terminal-mux.ts
// and backend/internal/terminal/protocol.go) with one addition: server frames
// carry a monotonic `seq`, and a reconnect resumes with `after=<last seq>` so
// the relay replays only the bytes this client has not seen. The contract in
// contracts/cloud/openapi.yaml documents the upgrade and its query parameters
// but not the frames; this is the framing the desktop expects.

import type { CloudClient, TerminalKind, TerminalScope } from "@aoagents/cloud-client";
import { base64ToBytes, closeFrame, dataFrame, openFrame, resizeFrame, type TerminalMux } from "./terminal-mux";

type ServerFrame = {
	ch?: string;
	id?: string;
	type?: string;
	data?: string;
	error?: string;
	seq?: number;
};

const PING_INTERVAL_MS = 20_000;
const PING_FRAME = JSON.stringify({ ch: "system", type: "ping" });

// Replay cursors outlive a single socket: useTerminalSession builds a fresh mux
// for every reconnect, and without a carried cursor each one would replay the
// session's whole scrollback again.
const replayCursors = new Map<string, number>();

function cursorKey(orgId: string, sessionId: string, kind: TerminalKind): string {
	return `${orgId}/${sessionId}/${kind}`;
}

/** Test seam: forget resume cursors between cases. */
export function resetCloudReplayCursors(): void {
	replayCursors.clear();
}

export type CloudTerminalMuxConfig = {
	client: CloudClient;
	orgId: string;
	sessionId: string;
	kind?: TerminalKind;
	WebSocketImpl?: typeof WebSocket;
};

type Listeners<T> = Map<string, Set<T>>;

function subscribeById<T>(map: Listeners<T>, id: string, listener: T): () => void {
	const set = map.get(id) ?? new Set<T>();
	set.add(listener);
	map.set(id, set);
	return () => set.delete(listener);
}

/**
 * A TerminalMux over the control-plane relay.
 *
 * Connecting is asynchronous (the ticket must be minted first) while the
 * interface is synchronous, so frames sent before the socket opens are queued
 * and flushed on connect — the same contract the local mux already has.
 */
export function createCloudTerminalMux(config: CloudTerminalMuxConfig): TerminalMux {
	const { client, orgId, sessionId } = config;
	const kind: TerminalKind = config.kind ?? "workspace";
	const WebSocketImpl = config.WebSocketImpl ?? WebSocket;
	const key = cursorKey(orgId, sessionId, kind);

	const encoder = new TextEncoder();
	const queue: string[] = [];
	const dataListeners: Listeners<(bytes: Uint8Array) => void> = new Map();
	const exitListeners: Listeners<() => void> = new Map();
	const openedListeners: Listeners<() => void> = new Map();
	const errorListeners: Listeners<(message: string) => void> = new Map();
	const connectionListeners = new Set<(state: "open" | "closed") => void>();

	let socket: WebSocket | null = null;
	let scopes: TerminalScope[] = [];
	let connectionState: "open" | "closed" | undefined;
	let pingTimer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;

	const setConnectionState = (next: "open" | "closed") => {
		if (disposed || connectionState === next) return;
		connectionState = next;
		connectionListeners.forEach((listener) => listener(next));
	};

	const reportError = (message: string) => {
		if (disposed) return;
		errorListeners.forEach((set) => set.forEach((listener) => listener(message)));
	};

	const send = (frame: string) => {
		if (disposed) return;
		if (socket && socket.readyState === WebSocketImpl.OPEN) socket.send(frame);
		else queue.push(frame);
	};

	// Read-only tickets exist so a viewer can watch a session without driving it.
	// Silently dropping keystrokes would look like a hung terminal, so say so once
	// per attempt through the pane's own error channel.
	const canOperate = () => {
		if (scopes.length === 0 || scopes.includes("terminal:operate")) return true;
		reportError("This AO Cloud terminal is read-only.");
		return false;
	};

	const handleFrame = (raw: string) => {
		let frame: ServerFrame;
		try {
			frame = JSON.parse(raw) as ServerFrame;
		} catch {
			return;
		}
		if (frame.ch !== "terminal") return;
		if (typeof frame.seq === "number") replayCursors.set(key, frame.seq);
		if (frame.type === "error") {
			const message = frame.error ?? "unknown terminal error";
			if (frame.id !== undefined) errorListeners.get(frame.id)?.forEach((listener) => listener(message));
			else reportError(message);
			return;
		}
		if (frame.id === undefined) return;
		if (frame.type === "data" && frame.data) {
			const bytes = base64ToBytes(frame.data);
			dataListeners.get(frame.id)?.forEach((listener) => listener(bytes));
		} else if (frame.type === "exited") {
			// The PTY is gone; a later attach must start from the top rather than
			// resume a cursor into a stream that no longer exists.
			replayCursors.delete(key);
			exitListeners.get(frame.id)?.forEach((listener) => listener());
		} else if (frame.type === "opened") {
			openedListeners.get(frame.id)?.forEach((listener) => listener());
		}
	};

	void (async () => {
		let ticket: { ticket: string; scopes: TerminalScope[] };
		try {
			ticket = await client.createTerminalTicket(orgId, sessionId, kind);
		} catch (error) {
			if (disposed) return;
			reportError(error instanceof Error ? error.message : "Could not authorize the AO Cloud terminal.");
			// Reported as a dropped connection, not a pane error: the attachment's
			// own backoff then retries, which is what an expired or rate-limited
			// ticket needs.
			setConnectionState("closed");
			return;
		}
		if (disposed) return;
		scopes = ticket.scopes;
		const url = client.terminalUrl(ticket.ticket, { after: replayCursors.get(key) ?? 0, kind });
		const next = new WebSocketImpl(url);
		socket = next;
		next.addEventListener("open", () => {
			if (disposed) return;
			while (queue.length > 0) {
				const frame = queue.shift();
				if (frame !== undefined) next.send(frame);
			}
			pingTimer = setInterval(() => send(PING_FRAME), PING_INTERVAL_MS);
			setConnectionState("open");
		});
		next.addEventListener("close", () => setConnectionState("closed"));
		next.addEventListener("error", () => setConnectionState("closed"));
		next.addEventListener("message", (event: MessageEvent) => {
			if (typeof event.data === "string") handleFrame(event.data);
		});
	})();

	return {
		open: (id, cols, rows) => send(openFrame(id, cols, rows)),
		sendInput: (id, input) => {
			if (!canOperate()) return;
			send(dataFrame(id, encoder.encode(input)));
		},
		resize: (id, cols, rows, force) => {
			if (!canOperate()) return;
			send(resizeFrame(id, cols, rows, force));
		},
		close: (id) => send(closeFrame(id)),
		onData: (id, listener) => subscribeById(dataListeners, id, listener),
		onExit: (id, listener) => subscribeById(exitListeners, id, listener),
		onOpened: (id, listener) => subscribeById(openedListeners, id, listener),
		onError: (id, listener) => subscribeById(errorListeners, id, listener),
		onConnectionChange: (listener) => {
			connectionListeners.add(listener);
			return () => connectionListeners.delete(listener);
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			if (pingTimer) clearInterval(pingTimer);
			dataListeners.clear();
			exitListeners.clear();
			openedListeners.clear();
			errorListeners.clear();
			connectionListeners.clear();
			try {
				socket?.close();
			} catch {
				// Already closing; nothing to release beyond the listeners above.
			}
		},
	};
}
