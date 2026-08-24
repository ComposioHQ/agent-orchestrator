import type { QueryClient } from "@tanstack/react-query";
import { getApiBaseUrl, hasTrustedApiBaseUrl, subscribeApiBaseUrl } from "./api-client";
import { computeBackoffDelayMs } from "./sse-backoff";
import { parseSseFrames } from "./sse-parse";

const INVALIDATE_DEBOUNCE_MS = 150;

type WorkspaceStream = {
	refs: number;
	disposed: boolean;
	// stopped is sticky for the life of a base URL: a 4xx means the session or
	// its workspace is gone, so reconnecting can never succeed. It is cleared
	// when the daemon base URL changes (a restarted daemon deserves a fresh try).
	stopped: boolean;
	failures: number;
	controller?: AbortController;
	connectedBaseUrl?: string;
	debounce?: ReturnType<typeof setTimeout>;
	retry?: ReturnType<typeof setTimeout>;
	disconnectBaseUrl: () => void;
	connect: () => void;
	dispose: () => void;
};

const streams = new Map<string, WorkspaceStream>();

// Shares one daemon watcher between the rail and maximized copies of a Files
// view. The daemon sends only invalidation edges; Git status and visible diffs
// are then refetched through the existing typed queries.
//
// The stream is read with fetch() + a ReadableStream rather than EventSource so
// the HTTP status is visible on failure: a 4xx (session/workspace gone) stops
// reconnecting entirely, while a 5xx/network failure backs off (honoring
// Retry-After). Native EventSource exposes no status, so it could only ever
// blindly reconnect.
export function subscribeWorkspaceFileChanges(sessionId: string, queryClient: QueryClient): () => void {
	let stream = streams.get(sessionId);
	if (!stream) {
		stream = createWorkspaceStream(sessionId, queryClient);
		streams.set(sessionId, stream);
	}
	stream.refs += 1;

	return () => {
		const current = streams.get(sessionId);
		if (!current) return;
		current.refs -= 1;
		if (current.refs > 0) return;
		current.dispose();
		streams.delete(sessionId);
	};
}

function retryAfterMs(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(header);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	return undefined;
}

function createWorkspaceStream(sessionId: string, queryClient: QueryClient): WorkspaceStream {
	const stream = {} as WorkspaceStream;

	const invalidate = () => {
		if (stream.debounce) clearTimeout(stream.debounce);
		stream.debounce = setTimeout(() => {
			void queryClient.invalidateQueries({ queryKey: ["session-workspace-files", sessionId] });
			void queryClient.invalidateQueries({ queryKey: ["session-workspace-file", sessionId] });
		}, INVALIDATE_DEBOUNCE_MS);
	};

	// scheduleRetry backs off unless an explicit delay (e.g. from Retry-After)
	// is supplied. It no-ops once the stream is stopped or disposed.
	const scheduleRetry = (overrideMs?: number) => {
		if (stream.disposed || stream.stopped || stream.retry) return;
		const delay = overrideMs ?? computeBackoffDelayMs(stream.failures);
		stream.failures += 1;
		stream.retry = setTimeout(() => {
			stream.retry = undefined;
			stream.connect();
		}, delay);
	};

	const runStream = async (controller: AbortController) => {
		const baseUrl = stream.connectedBaseUrl;
		if (!baseUrl) return;
		const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/sessions/${encodeURIComponent(sessionId)}/workspace/events`;

		// Release this attempt's controller slot (only if we still own it) so a
		// scheduled retry's connect() is not blocked by the "already connecting"
		// guard. Must run before scheduleRetry on every current-owner exit.
		const release = () => {
			if (stream.controller === controller) stream.controller = undefined;
		};

		let response: Response;
		try {
			response = await fetch(url, { headers: { Accept: "text/event-stream" }, signal: controller.signal });
		} catch {
			// Network error or abort. If we were aborted/disposed/superseded, stay
			// quiet; otherwise this is a transient failure — back off and retry.
			if (!isCurrent(controller)) return;
			release();
			scheduleRetry();
			return;
		}
		if (!isCurrent(controller)) return;

		if (response.status >= 400 && response.status < 500) {
			// The session or its workspace is gone (or the request is invalid).
			// Reconnecting can never succeed, so stop instead of looping.
			release();
			stream.stopped = true;
			return;
		}
		if (!response.ok || !response.body) {
			// 5xx (or a bodiless response): transient. Honor Retry-After if the
			// server sent one, else exponential backoff.
			release();
			scheduleRetry(retryAfterMs(response));
			return;
		}

		// Healthy stream: reset backoff and refresh once, then read events.
		stream.failures = 0;
		invalidate();
		try {
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const { events, rest } = parseSseFrames(buffer);
				buffer = rest;
				for (const ev of events) {
					if (ev.event === "workspace_changed" && isCurrent(controller)) invalidate();
				}
				if (!isCurrent(controller)) return;
			}
		} catch {
			// Read error mid-stream; fall through to reconnect.
		}
		if (!isCurrent(controller)) return;
		// The server closed a previously-healthy stream (e.g. keepalive lapse).
		// failures was reset on open, so this reconnects promptly.
		release();
		scheduleRetry();
	};

	const isCurrent = (controller: AbortController): boolean =>
		!stream.disposed && !controller.signal.aborted && stream.controller === controller;

	stream.refs = 0;
	stream.disposed = false;
	stream.stopped = false;
	stream.failures = 0;

	stream.connect = () => {
		if (stream.disposed || stream.stopped || typeof fetch === "undefined") return;
		if (!hasTrustedApiBaseUrl()) {
			stream.controller?.abort();
			stream.controller = undefined;
			stream.connectedBaseUrl = undefined;
			return;
		}
		const baseUrl = getApiBaseUrl();
		// A new daemon (base URL changed) resets the sticky stop and the backoff:
		// a restarted daemon deserves a fresh attempt.
		if (baseUrl !== stream.connectedBaseUrl) {
			stream.stopped = false;
			stream.failures = 0;
		} else if (stream.controller) {
			return; // already connected/connecting to this base URL
		}
		stream.controller?.abort();
		const controller = new AbortController();
		stream.controller = controller;
		stream.connectedBaseUrl = baseUrl;
		void runStream(controller);
	};

	stream.disconnectBaseUrl = subscribeApiBaseUrl(stream.connect);
	stream.dispose = () => {
		stream.disposed = true;
		if (stream.debounce) clearTimeout(stream.debounce);
		if (stream.retry) clearTimeout(stream.retry);
		stream.disconnectBaseUrl();
		stream.controller?.abort();
	};

	stream.connect();
	return stream;
}
