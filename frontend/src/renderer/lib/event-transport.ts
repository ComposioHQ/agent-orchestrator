import type { QueryClient } from "@tanstack/react-query";
import { aoBridge } from "./bridge";
import { getApiBaseUrl, hasTrustedApiBaseUrl, subscribeApiBaseUrl } from "./api-client";
import { setEventsConnectionState } from "./events-connection";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { sessionScmSummaryQueryKey } from "../hooks/useSessionScmSummary";
import { conversationQueryKey } from "../hooks/useConversation";
import { sessionUsageQueryRoot } from "../hooks/useSessionUsageSummaries";

export type EventTransport = {
	connect: () => () => void;
};

const INVALIDATE_DEBOUNCE_MS = 150;
// A continuous CDC stream (an active agent emits several session_updated
// events per second) would keep postponing a pure trailing debounce, so cap
// how long a workspace flush can be deferred, and keep consecutive workspace
// refetch rounds at least this far apart. Conversation invalidations stay on
// the plain debounce so a streaming chat turn keeps its current cadence.
const INVALIDATE_MAX_WAIT_MS = 1_000;
const INVALIDATE_MIN_INTERVAL_MS = 1_000;
// How long to wait before rebuilding an EventSource the browser gave up on
// (readyState CLOSED — e.g. the daemon answered with a non-SSE response).
const SSE_RETRY_MS = 5_000;
// EventSource.CLOSED, referenced numerically so test stubs without the static
// constants still work.
const EVENTSOURCE_CLOSED = 2;

// CDC event types the daemon pushes over the SSE stream (see
// backend/internal/cdc/event.go). The SSE writer tags each frame with
// `event: <type>`, so named events bypass EventSource.onmessage and must be
// subscribed explicitly. Every one of these can change the project/session list
// the sidebar renders, so they all trigger a (debounced) workspace refetch.
// Only the PR-shaped ones can change a session's SCM (PR detail) summary, and
// only the session-shaped ones can change usage totals — the flush below uses
// that split to avoid refetching every mounted per-session query on each event.
const SESSION_EVENT_TYPES = ["session_created", "session_updated"] as const;
const PR_EVENT_TYPES = [
	"pr_created",
	"pr_updated",
	"pr_check_recorded",
	"pr_session_changed",
	"pr_review_thread_added",
	"pr_review_thread_resolved",
] as const;
const CDC_EVENT_TYPES = [...SESSION_EVENT_TYPES, ...PR_EVENT_TYPES] as const;
const PR_EVENT_TYPE_SET: ReadonlySet<string> = new Set(PR_EVENT_TYPES);

/**
 * Wires live server state into the TanStack Query cache. Two sources feed it:
 *   - daemon lifecycle over Electron IPC (coming up/down changes session availability)
 *   - the backend CDC stream over SSE (project/session/PR changes)
 * Both invalidate the ["workspaces"] query so the UI refetches. Invalidations are
 * debounced because a single user action can emit a burst of CDC events.
 */
export function createEventTransport(queryClient: QueryClient): EventTransport {
	return {
		connect() {
			let debounce: ReturnType<typeof setTimeout> | undefined;
			let conversationDebounce: ReturnType<typeof setTimeout> | undefined;
			// Set while a workspace flush is pending; bounds how far the trailing
			// debounce can slide under a continuous event stream.
			let flushDeadline: number | undefined;
			let lastFlushAt: number | undefined;
			const pendingConversationSessions = new Set<string>();
			// Scoped invalidation targets accumulated between flushes.
			let workspacePending = false;
			let usagePending = false;
			let scmRootPending = false;
			const pendingScmSessions = new Set<string>();
			let retryTimer: ReturnType<typeof setTimeout> | undefined;
			let source: EventSource | undefined;
			let sourceBaseUrl: string | undefined;
			const flushInvalidations = () => {
				debounce = undefined;
				flushDeadline = undefined;
				lastFlushAt = Date.now();
				if (workspacePending) {
					void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
					workspacePending = false;
				}
				if (scmRootPending) {
					void queryClient.invalidateQueries({ queryKey: sessionScmSummaryQueryKey() });
				} else {
					for (const sessionId of pendingScmSessions) {
						void queryClient.invalidateQueries({ queryKey: sessionScmSummaryQueryKey(sessionId) });
					}
				}
				scmRootPending = false;
				pendingScmSessions.clear();
				if (usagePending) {
					void queryClient.invalidateQueries({ queryKey: sessionUsageQueryRoot });
					usagePending = false;
				}
			};
			const flushConversationInvalidations = () => {
				conversationDebounce = undefined;
				for (const sessionId of pendingConversationSessions) {
					void queryClient.invalidateQueries({ queryKey: conversationQueryKey(sessionId) });
				}
				pendingConversationSessions.clear();
			};
			const scheduleFlush = () => {
				const now = Date.now();
				if (flushDeadline === undefined) flushDeadline = now + INVALIDATE_MAX_WAIT_MS;
				// Trailing debounce, but never past the deadline and never sooner
				// than the minimum interval since the previous flush.
				const debounceDelay = Math.max(0, Math.min(INVALIDATE_DEBOUNCE_MS, flushDeadline - now));
				const throttleDelay = lastFlushAt === undefined ? 0 : Math.max(0, lastFlushAt + INVALIDATE_MIN_INTERVAL_MS - now);
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(flushInvalidations, Math.max(debounceDelay, throttleDelay));
			};
			const scheduleConversationFlush = () => {
				if (conversationDebounce) clearTimeout(conversationDebounce);
				conversationDebounce = setTimeout(flushConversationInvalidations, INVALIDATE_DEBOUNCE_MS);
			};
			const refreshWorkspaces = (event?: Event) => {
				let conversationOnly = false;
				// Refreshes without a CDC event (daemon status change, stream (re)open)
				// recover an unknown gap, so everything is refetched.
				let scmScope: "all" | "none" | string = event ? "none" : "all";
				let usageRelevant = !event;
				if (event && "data" in event) {
					try {
						const decoded = JSON.parse(String((event as MessageEvent).data)) as {
							sessionId?: unknown;
							payload?: unknown;
						};
						// The SSE endpoint sends the complete durable CDC event. Routing
						// fields such as sessionId live on that envelope, while trigger-built
						// details such as conversationId live inside its payload. Do not
						// mistake the payload for the entire event: doing so refreshes the
						// sidebar but leaves a Chat timeline frozen on its pre-turn snapshot.
						const payload =
							typeof decoded.payload === "object" && decoded.payload !== null
								? (decoded.payload as { conversationId?: unknown })
								: undefined;
						if (
							typeof decoded.sessionId === "string" &&
							decoded.sessionId &&
							typeof payload?.conversationId === "string" &&
							payload.conversationId
						) {
							pendingConversationSessions.add(decoded.sessionId);
							conversationOnly = true;
						}
						if (PR_EVENT_TYPE_SET.has(event.type)) {
							// pr_session_changed moves a PR between sessions, so the summary
							// of a session other than the envelope's may change too.
							if (event.type !== "pr_session_changed" && typeof decoded.sessionId === "string" && decoded.sessionId) {
								scmScope = decoded.sessionId;
							} else {
								scmScope = "all";
							}
						} else if (event.type === "session_created" || event.type === "session_updated") {
							// Session-shaped events carry activity and usage-binding changes;
							// PR summaries only change through the pr_* triggers above.
							usageRelevant = true;
						} else {
							// Unnamed or unrecognized event: refresh everything.
							scmScope = "all";
							usageRelevant = true;
						}
					} catch {
						// A malformed CDC payload still refreshes everything; it simply
						// cannot be routed precisely.
						scmScope = "all";
						usageRelevant = true;
					}
				}
				if (conversationOnly) {
					scheduleConversationFlush();
					return;
				}
				workspacePending = true;
				if (usageRelevant) usagePending = true;
				if (scmScope === "all") scmRootPending = true;
				else if (scmScope !== "none") pendingScmSessions.add(scmScope);
				scheduleFlush();
			};

			const scheduleRetry = () => {
				if (retryTimer) return;
				retryTimer = setTimeout(() => {
					retryTimer = undefined;
					connectSource();
				}, SSE_RETRY_MS);
			};

			const connectSource = () => {
				// EventSource is unavailable in jsdom (tests) and some preview surfaces; guard it.
				if (typeof EventSource === "undefined") return;
				if (!hasTrustedApiBaseUrl()) {
					source?.close();
					source = undefined;
					sourceBaseUrl = undefined;
					setEventsConnectionState("disconnected");
					return;
				}
				const baseUrl = getApiBaseUrl();
				// Keep a still-usable source on the same base URL; replace one the
				// browser abandoned (CLOSED) or one bound to a stale port.
				if (source && sourceBaseUrl === baseUrl && source.readyState !== EVENTSOURCE_CLOSED) return;
				source?.close();
				source = undefined;
				sourceBaseUrl = baseUrl;
				try {
					source = new EventSource(`${baseUrl.replace(/\/+$/, "")}/api/v1/events`);
					source.onopen = () => {
						setEventsConnectionState("connected");
						// Events emitted during the gap were lost; refetch once on (re)open.
						refreshWorkspaces();
					};
					source.onerror = () => {
						// While readyState is CONNECTING the browser retries on its own;
						// either way the stream is not delivering, so surface it instead
						// of looping silently against a dead daemon.
						setEventsConnectionState("disconnected");
						if (source?.readyState === EVENTSOURCE_CLOSED) scheduleRetry();
					};
					source.onmessage = refreshWorkspaces; // unnamed events, if any
					for (const type of CDC_EVENT_TYPES) {
						source.addEventListener(type, refreshWorkspaces);
					}
					// EventSource auto-reconnects and resumes via Last-Event-ID while
					// CONNECTING; scheduleRetry only covers the terminal CLOSED state.
				} catch {
					source = undefined;
				}
			};

			const removeDaemonListener = aoBridge.daemon.onStatus(() => {
				connectSource();
				refreshWorkspaces();
			});
			// Rebind when the daemon comes back on a different port, independent of
			// status-event ordering.
			const removeBaseUrlListener = subscribeApiBaseUrl(connectSource);
			connectSource();

			return () => {
				if (debounce) clearTimeout(debounce);
				if (conversationDebounce) clearTimeout(conversationDebounce);
				if (retryTimer) clearTimeout(retryTimer);
				removeDaemonListener();
				removeBaseUrlListener();
				source?.close();
				setEventsConnectionState("idle");
			};
		},
	};
}
