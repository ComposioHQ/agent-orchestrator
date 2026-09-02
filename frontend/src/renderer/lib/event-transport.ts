import type { QueryClient } from "@tanstack/react-query";
import { aoBridge } from "./bridge";
import { subscribeApiBaseUrl } from "./api-client";
import { setEventsConnectionState } from "./events-connection";
import { connectedHosts, subscribeConnectedHosts } from "./host-clients";
import { closeAllHostStreams, syncHostStreams } from "./host-events";
import { LOCAL_HOST, type HostId } from "./hosts";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { sessionScmSummaryQueryKey } from "../hooks/useSessionScmSummary";
import { conversationQueryKey, conversationQueryRoot } from "../hooks/useConversation";
import { agentSwitchesQueryRoot } from "../hooks/useAgentSwitches";
import { sessionUsageQueryRoot } from "../hooks/useSessionUsageSummaries";

export type EventTransport = {
	connect: () => () => void;
};

const INVALIDATE_DEBOUNCE_MS = 150;

/**
 * Wires live server state into the TanStack Query cache. Two sources feed it:
 *   - daemon lifecycle over Electron IPC (coming up/down changes session availability)
 *   - the backend CDC stream over SSE (project/session/PR changes)
 * Daemon lifecycle invalidates the workspace root; each SSE stream invalidates
 * only its host key. Invalidations are debounced because one action can emit a
 * burst of CDC events.
 */
export function createEventTransport(queryClient: QueryClient): EventTransport {
	return {
		connect() {
			closeAllHostStreams();
			let debounce: ReturnType<typeof setTimeout> | undefined;
			const pendingConversationSessions = new Set<string>();
			const pendingInterfaceTransitionSessions = new Set<string>();
			let workspaceInvalidationPending = false;
			let allConversationsInvalidationPending = false;
			const pendingWorkspaceHosts = new Set<HostId>();
			const refreshWorkspaces = (host?: HostId, event?: Event) => {
				let conversationOnly = false;
				if (event === undefined) {
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
				if (!conversationOnly) {
					if (host) pendingWorkspaceHosts.add(host);
					else workspaceInvalidationPending = true;
				}
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
					for (const pendingHost of pendingWorkspaceHosts) {
						void queryClient.invalidateQueries({
							queryKey: [...workspaceQueryKey, pendingHost],
						});
					}
					pendingWorkspaceHosts.clear();
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

			const connectSources = () => {
				syncHostStreams([LOCAL_HOST, ...connectedHosts()], refreshWorkspaces);
			};

			const removeDaemonListener = aoBridge.daemon.onStatus(() => {
				connectSources();
				refreshWorkspaces();
			});
			// Rebind when the daemon comes back on a different port, independent of
			// status-event ordering.
			const removeBaseUrlListener = subscribeApiBaseUrl(connectSources);
			const removeHostsListener = subscribeConnectedHosts(connectSources);
			connectSources();

			return () => {
				if (debounce) clearTimeout(debounce);
				removeDaemonListener();
				removeBaseUrlListener();
				removeHostsListener();
				closeAllHostStreams();
				setEventsConnectionState("idle");
			};
		},
	};
}
