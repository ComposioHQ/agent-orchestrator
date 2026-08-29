import type { QueryClient } from "@tanstack/react-query";
import { aoBridge } from "./bridge";
import { getApiBaseUrl, hasTrustedApiBaseUrl, subscribeApiBaseUrl } from "./api-client";
import { setEventsConnectionState } from "./events-connection";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { sessionScmSummaryQueryKey } from "../hooks/useSessionScmSummary";
import { conversationQueryKey, conversationQueryRoot } from "../hooks/useConversation";
import { agentSwitchesQueryRoot } from "../hooks/useAgentSwitches";
import { sessionUsageQueryRoot } from "../hooks/useSessionUsageSummaries";
import { codexProfilesQueryKey } from "../hooks/codex-profile-cache";
import type { components } from "../../api/schema";

export type EventTransport = {
	connect: () => () => void;
};

const INVALIDATE_DEBOUNCE_MS = 150;
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

/**
 * Wires live server state into the TanStack Query cache. Three sources feed it:
 *   - daemon lifecycle over Electron IPC (coming up/down changes session availability)
 *   - the backend CDC stream over SSE (project/session/PR changes)
 *   - the Codex capacity stream over SSE (profile-scoped advisory state)
 * Both invalidate the ["workspaces"] query so the UI refetches. Invalidations are
 * debounced because a single user action can emit a burst of CDC events.
 */
export function createEventTransport(queryClient: QueryClient): EventTransport {
	return {
		connect() {
			let debounce: ReturnType<typeof setTimeout> | undefined;
			const pendingConversationSessions = new Set<string>();
			const pendingInterfaceTransitionSessions = new Set<string>();
			let workspaceInvalidationPending = false;
			let allConversationsInvalidationPending = false;
			let retryTimer: ReturnType<typeof setTimeout> | undefined;
			let source: EventSource | undefined;
			let sourceBaseUrl: string | undefined;
			let capacitySource: EventSource | undefined;
			let capacitySourceBaseUrl: string | undefined;
			const applyCapacityEvent = (event: Event) => {
				if (!("data" in event)) return;
				try {
					const decoded = JSON.parse(String((event as MessageEvent).data)) as components["schemas"]["CodexProfileCapacityEvent"];
					queryClient.setQueryData<components["schemas"]["CodexProfilesResponse"]>(codexProfilesQueryKey, (current) => {
						if (!current) return current;
						if (decoded.capacity === null) return { ...current, profiles: current.profiles.filter((profile) => profile.id !== decoded.profileId) };
						const capacity = decoded.capacity;
						return { ...current, profiles: current.profiles.map((profile) => profile.id === decoded.profileId ? { ...profile, capacity } : profile) };
					});
					void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
				} catch {
					// A malformed transient event cannot replace the cached safe snapshot.
				}
			};
			const refreshWorkspaces = (event?: Event) => {
				let conversationOnly = false;
				if (event === undefined) {
					// A lifecycle refresh -- reconnect, daemon status change, base-URL change --
					// carries no event, so we cannot know which conversations moved. Normally the
					// replay that follows tells us, but when the event log has been truncated the
					// daemon starts us at head and no CDC arrives at all. EventSource cannot read
					// the header reporting that clamp, so refresh every conversation instead of
					// leaving an open chat frozen on its pre-gap snapshot.
					allConversationsInvalidationPending = true;
				}
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
								? (decoded.payload as {
										conversationId?: unknown;
										interfaceTransitionId?: unknown;
								  })
								: undefined;
						if (
							typeof decoded.sessionId === "string" &&
							decoded.sessionId &&
							typeof payload?.interfaceTransitionId === "string" &&
							payload.interfaceTransitionId
						) {
							pendingInterfaceTransitionSessions.add(decoded.sessionId);
						}
						if (
							typeof decoded.sessionId === "string" &&
							decoded.sessionId &&
							typeof payload?.conversationId === "string" &&
							payload.conversationId
						) {
							pendingConversationSessions.add(decoded.sessionId);
							conversationOnly = true;
						}
					} catch {
						// A malformed CDC payload still invalidates workspaces; it simply
						// cannot target a conversation cache precisely.
					}
				}
				if (!conversationOnly) workspaceInvalidationPending = true;
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(() => {
					if (allConversationsInvalidationPending) {
						void queryClient.invalidateQueries({ queryKey: conversationQueryRoot });
						allConversationsInvalidationPending = false;
					}
					if (workspaceInvalidationPending) {
						void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
						void queryClient.invalidateQueries({ queryKey: agentSwitchesQueryRoot });
						void queryClient.invalidateQueries({ queryKey: sessionScmSummaryQueryKey() });
						void queryClient.invalidateQueries({ queryKey: sessionUsageQueryRoot });
						workspaceInvalidationPending = false;
					}
					for (const sessionId of pendingConversationSessions) {
						void queryClient.invalidateQueries({ queryKey: conversationQueryKey(sessionId) });
					}
					pendingConversationSessions.clear();
					for (const sessionId of pendingInterfaceTransitionSessions) {
						void queryClient.invalidateQueries({
							queryKey: ["session-interface-transition", sessionId],
						});
					}
					pendingInterfaceTransitionSessions.clear();
				}, INVALIDATE_DEBOUNCE_MS);
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
					capacitySource?.close();
					source = undefined;
					capacitySource = undefined;
					sourceBaseUrl = undefined;
					capacitySourceBaseUrl = undefined;
					setEventsConnectionState("disconnected");
					return;
				}
				const baseUrl = getApiBaseUrl();
				if (!capacitySource || capacitySourceBaseUrl !== baseUrl || capacitySource.readyState === EVENTSOURCE_CLOSED) {
					capacitySource?.close();
					capacitySourceBaseUrl = baseUrl;
					try {
						capacitySource = new EventSource(`${baseUrl.replace(/\/+$/, "")}/api/v1/agents/codex/profiles/capacity/events`);
						capacitySource.onopen = () => {
							void queryClient.invalidateQueries({ queryKey: codexProfilesQueryKey });
							void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
						};
						capacitySource.onerror = () => { if (capacitySource?.readyState === EVENTSOURCE_CLOSED) scheduleRetry(); };
						capacitySource.addEventListener("codex_profile_capacity", applyCapacityEvent);
					} catch {
						capacitySource = undefined;
					}
				}
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
				if (retryTimer) clearTimeout(retryTimer);
				removeDaemonListener();
				removeBaseUrlListener();
				source?.close();
				capacitySource?.close();
				setEventsConnectionState("idle");
			};
		},
	};
}
