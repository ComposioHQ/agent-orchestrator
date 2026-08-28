import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
	clearConversationProviderCatalogs,
	conversationQueryKey,
	invalidateConversationProviderCatalogs,
} from "./useConversation";

/**
 * Keeps Chat provider catalogs aligned with the controller epoch during agent switches.
 *
 * Admission clears and pauses catalog queries so a 202 refetch cannot repopulate
 * the outgoing provider's options. Durable success or failure then refetches once
 * the target or recovered source controller owns the session.
 *
 * Switch selection and observation belong to the Chat surface. This hook only
 * applies provider-cache side effects for that canonical lifecycle.
 */
export function useAgentSwitchProviderCatalogs({
	sessionId,
	agentSwitching,
	observedSettledSwitchId,
}: {
	sessionId: string;
	agentSwitching: boolean;
	observedSettledSwitchId?: string;
}): boolean {
	const queryClient = useQueryClient();
	const refreshedSwitchIdsRef = useRef(new Set<string>());
	const clearedWhileSwitchingRef = useRef(false);
	const mountedSessionIdRef = useRef(sessionId);

	if (mountedSessionIdRef.current !== sessionId) {
		mountedSessionIdRef.current = sessionId;
		refreshedSwitchIdsRef.current = new Set();
		clearedWhileSwitchingRef.current = false;
	}

	useEffect(() => {
		if (!agentSwitching) {
			clearedWhileSwitchingRef.current = false;
			return;
		}
		if (clearedWhileSwitchingRef.current) return;
		clearedWhileSwitchingRef.current = true;
		clearConversationProviderCatalogs(queryClient, sessionId);
	}, [agentSwitching, queryClient, sessionId]);

	useEffect(() => {
		if (!observedSettledSwitchId) return;
		if (refreshedSwitchIdsRef.current.has(observedSettledSwitchId)) return;
		refreshedSwitchIdsRef.current.add(observedSettledSwitchId);
		invalidateConversationProviderCatalogs(queryClient, sessionId);
		void queryClient.invalidateQueries({ queryKey: conversationQueryKey(sessionId) });
	}, [observedSettledSwitchId, queryClient, sessionId]);

	return !agentSwitching;
}
