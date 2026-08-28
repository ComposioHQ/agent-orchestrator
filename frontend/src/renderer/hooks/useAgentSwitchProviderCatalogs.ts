import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { deriveAgentSwitchPresentation } from "../lib/agent-switch-presentation";
import type { AgentSwitchSummary, WorkspaceSession } from "../types/workspace";
import {
	findActiveAgentSwitch,
	selectDurableAgentSwitch,
	useAgentSwitches,
} from "./useAgentSwitches";
import {
	clearConversationProviderCatalogs,
	conversationQueryKey,
	invalidateConversationProviderCatalogs,
} from "./useConversation";
import { useObservedAgentSwitchLifecycle } from "./useObservedAgentSwitchLifecycle";
import { useSwitchAgentState, type SwitchAgentHarness } from "./useSwitchAgent";

function resolveAdmissionAgentSwitch(
	switchPending: boolean,
	switchInput?: { idempotencyKey: string; session: WorkspaceSession; targetHarness: SwitchAgentHarness },
): AgentSwitchSummary | undefined {
	return switchPending && switchInput
		? {
				agentHandoffStatus: "not_attempted",
				fromHarness: switchInput.session.provider,
				id: `admission:${switchInput.idempotencyKey}`,
				state: "preparing_handoff",
				targetHarness: switchInput.targetHarness,
			}
		: undefined;
}

/**
 * Keeps Chat provider catalogs aligned with the controller epoch during agent switches.
 *
 * Admission clears and pauses catalog queries so a 202 refetch cannot repopulate
 * the outgoing provider's options. Durable success or failure then refetches once
 * the target or recovered source controller owns the session.
 */
export function useAgentSwitchProviderCatalogs(
	session: WorkspaceSession,
	targetChatControllerReady: boolean,
) {
	const queryClient = useQueryClient();
	const agentSwitchesQuery = useAgentSwitches(session.id);
	const switchMutation = useSwitchAgentState(session.id);
	const agentSwitches = agentSwitchesQuery.data ?? [];
	const selectedDurableAgentSwitch = selectDurableAgentSwitch(
		session.activeAgentSwitch,
		agentSwitches,
	);
	const activeHistorySwitch = findActiveAgentSwitch(agentSwitches);
	const admissionAgentSwitch = resolveAdmissionAgentSwitch(
		switchMutation.isPending,
		switchMutation.input,
	);
	const { isObserved, isRetired, observedTerminalSwitch, retire } =
		useObservedAgentSwitchLifecycle({
			sessionId: session.id,
			agentSwitches,
			nonterminalCandidates: [
				session.activeAgentSwitch,
				activeHistorySwitch,
				selectedDurableAgentSwitch,
				admissionAgentSwitch,
			],
		});
	const durableAgentSwitch =
		selectedDurableAgentSwitch && !isRetired(selectedDurableAgentSwitch.id)
			? selectedDurableAgentSwitch
			: undefined;
	const agentSwitch = durableAgentSwitch ?? admissionAgentSwitch ?? observedTerminalSwitch;
	const refreshedSwitchIdsRef = useRef(new Set<string>());
	const clearedWhileSwitchingRef = useRef(false);
	const mountedSessionIdRef = useRef(session.id);

	if (mountedSessionIdRef.current !== session.id) {
		mountedSessionIdRef.current = session.id;
		refreshedSwitchIdsRef.current = new Set();
		clearedWhileSwitchingRef.current = false;
	}
	const presentation = agentSwitch
		? deriveAgentSwitchPresentation({
				agentSwitch,
				activityState: session.activity?.state,
				currentHarness: session.provider,
				isTerminated: Boolean(session.isTerminated),
				terminalHandleId: targetChatControllerReady ? "chat-controller" : undefined,
			})
		: undefined;
	const agentSwitching = Boolean(
		switchMutation.isPending ||
			(agentSwitch &&
				(presentation?.outcome === "in_progress" || presentation?.outcome === "recovery")),
	);

	const observedSettledSwitch = Boolean(
		agentSwitch &&
			(presentation?.outcome === "success" || presentation?.outcome === "failure") &&
			isObserved(agentSwitch.id),
	);

	useEffect(() => {
		if (!agentSwitching) {
			clearedWhileSwitchingRef.current = false;
			return;
		}
		if (clearedWhileSwitchingRef.current) return;
		clearedWhileSwitchingRef.current = true;
		clearConversationProviderCatalogs(queryClient, session.id);
	}, [agentSwitching, queryClient, session.id]);

	useEffect(() => {
		if (!observedSettledSwitch || !agentSwitch) return;
		if (refreshedSwitchIdsRef.current.has(agentSwitch.id)) return;
		refreshedSwitchIdsRef.current.add(agentSwitch.id);
		invalidateConversationProviderCatalogs(queryClient, session.id);
		void queryClient.invalidateQueries({ queryKey: conversationQueryKey(session.id) });
		retire(agentSwitch.id);
	}, [agentSwitch, observedSettledSwitch, queryClient, retire, session.id]);

	return { catalogsEnabled: !agentSwitching };
}
