import { baseUrlFor } from "./host-clients";
import { reportHostStreamState } from "./host-telemetry";
import { LOCAL_HOST, type HostId } from "./hosts";
import { setEventsConnectionState, type EventsConnectionState } from "./events-connection";

const SSE_RETRY_MS = 5_000;
const EVENTSOURCE_CLOSED = 2;

const CDC_EVENT_TYPES = [
	"session_created",
	"session_updated",
	"pr_created",
	"pr_updated",
	"pr_check_recorded",
	"pr_session_changed",
	"pr_review_thread_added",
	"pr_review_thread_resolved",
	"review_run_created",
	"review_run_updated",
] as const;

type HostEventHandler = (host: HostId, event?: Event) => void;
type HostStream = {
	source: EventSource;
	base: string;
	state: "connected" | "disconnected";
	onEvent: HostEventHandler;
	retryTimer?: ReturnType<typeof setTimeout>;
};

const streams = new Map<HostId, HostStream>();
// How many times each host's stream has dropped this session. Kept beside the
// streams rather than on one, because a reconnect builds a new stream object
// and the count of drops is the whole point of the signal.
const streamDrops = new Map<HostId, number>();

function setConnectionState(host: HostId, stream: HostStream, state: HostStream["state"]): void {
	// Transitions only: onerror fires repeatedly while EventSource is CONNECTING,
	// and one drop must report as one drop.
	if (stream.state === state) return;
	stream.state = state;
	if (host === LOCAL_HOST) setEventsConnectionState(state);
	if (state === "disconnected") streamDrops.set(host, (streamDrops.get(host) ?? 0) + 1);
	reportHostStreamState(host, state, streamDrops.get(host) ?? 0);
}

function closeHostStream(host: HostId): void {
	const stream = streams.get(host);
	if (!stream) return;
	if (stream.retryTimer) clearTimeout(stream.retryTimer);
	stream.source.close();
	streams.delete(host);
	// A deliberate teardown is not a drop, so the count goes with the stream.
	streamDrops.delete(host);
	if (host === LOCAL_HOST) setEventsConnectionState("disconnected");
}

function connectHostStream(host: HostId, onEvent: HostEventHandler): void {
	// EventSource is unavailable in jsdom and some preview surfaces.
	if (typeof EventSource === "undefined") return;
	const base = baseUrlFor(host);
	if (base === null) {
		closeHostStream(host);
		if (host === LOCAL_HOST) setEventsConnectionState("disconnected");
		return;
	}

	const current = streams.get(host);
	if (current && current.base === base && current.source.readyState !== EVENTSOURCE_CLOSED) {
		current.onEvent = onEvent;
		return;
	}
	closeHostStream(host);

	try {
		const source = new EventSource(`${base.replace(/\/+$/, "")}/api/v1/events`);
		const stream: HostStream = { source, base, state: "disconnected", onEvent };
		streams.set(host, stream);

		const reportEvent = (event?: Event) => {
			if (event === undefined) stream.onEvent(host);
			else stream.onEvent(host, event);
		};
		source.onopen = () => {
			if (streams.get(host) !== stream) return;
			setConnectionState(host, stream, "connected");
			// Events emitted during the gap were lost; refetch once on (re)open.
			stream.onEvent(host);
		};
		source.onerror = () => {
			if (streams.get(host) !== stream) return;
			setConnectionState(host, stream, "disconnected");
			// While CONNECTING the browser retries and resumes via Last-Event-ID.
			if (source.readyState !== EVENTSOURCE_CLOSED || stream.retryTimer) return;
			stream.retryTimer = setTimeout(() => {
				stream.retryTimer = undefined;
				if (streams.get(host) === stream) connectHostStream(host, stream.onEvent);
			}, SSE_RETRY_MS);
		};
		source.onmessage = reportEvent;
		for (const type of CDC_EVENT_TYPES) source.addEventListener(type, reportEvent);
	} catch {
		if (host === LOCAL_HOST) setEventsConnectionState("disconnected");
	}
}

export function syncHostStreams(hosts: HostId[], onEvent: HostEventHandler): void {
	const wanted = new Set(hosts);
	for (const host of streams.keys()) {
		if (!wanted.has(host)) closeHostStream(host);
	}
	for (const host of wanted) connectHostStream(host, onEvent);
}

/**
 * Whether this host's live updates are flowing.
 *
 * "idle" — no stream at all (never opened, or torn down) — is deliberately
 * distinct from "disconnected": only the second one means the board went stale
 * on a host that is meant to be live, and only it is worth telling anyone about.
 */
export function hostConnectionState(host: HostId): EventsConnectionState {
	return streams.get(host)?.state ?? "idle";
}

export function closeAllHostStreams(): void {
	for (const host of [...streams.keys()]) closeHostStream(host);
}
