import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSwitchSummary } from "../types/workspace";
import { isTerminalAgentSwitch, type AgentSwitch } from "./useAgentSwitches";

type LifecycleState = {
	sessionId: string | undefined;
	observedSwitchIds: Set<string>;
	retiredSwitchIds: Set<string>;
};

type SessionSwitchSelection = {
	sessionId: string | undefined;
	switchId: string;
};

/**
 * Owns the outcome lifecycle shared by the TUI and Chat session surfaces.
 * Terminal history is presentable only after this mount observed that switch
 * running, and a presented success is retired once its transient notice ends.
 */
export function useObservedAgentSwitchLifecycle({
	sessionId,
	agentSwitches,
	nonterminalCandidates,
}: {
	sessionId: string | undefined;
	agentSwitches: AgentSwitch[];
	nonterminalCandidates: Array<AgentSwitchSummary | undefined>;
}) {
	const [transientSuccess, setTransientSuccess] = useState<SessionSwitchSelection>();
	const [dismissedFailure, setDismissedFailure] = useState<SessionSwitchSelection>();
	const stateRef = useRef<LifecycleState>({
		sessionId,
		observedSwitchIds: new Set(),
		retiredSwitchIds: new Set(),
	});
	if (stateRef.current.sessionId !== sessionId) {
		stateRef.current = {
			sessionId,
			observedSwitchIds: new Set(),
			retiredSwitchIds: new Set(),
		};
	}
	for (const candidate of nonterminalCandidates) {
		if (
			candidate &&
			!isTerminalAgentSwitch(candidate) &&
			!stateRef.current.retiredSwitchIds.has(candidate.id)
		) {
			stateRef.current.observedSwitchIds.add(candidate.id);
		}
	}

	const markObserved = useCallback((switchId: string) => {
		if (!stateRef.current.retiredSwitchIds.has(switchId)) {
			stateRef.current.observedSwitchIds.add(switchId);
		}
	}, []);
	const retire = useCallback((switchId: string) => {
		stateRef.current.observedSwitchIds.delete(switchId);
		stateRef.current.retiredSwitchIds.add(switchId);
	}, []);
	const isObserved = useCallback(
		(switchId: string) =>
			stateRef.current.observedSwitchIds.has(switchId) &&
			!stateRef.current.retiredSwitchIds.has(switchId),
		[],
	);
	const isRetired = useCallback(
		(switchId: string) => stateRef.current.retiredSwitchIds.has(switchId),
		[],
	);
	const settle = useCallback(
		(switchId: string) => {
			if (!stateRef.current.observedSwitchIds.has(switchId)) return;
			setTransientSuccess({ sessionId, switchId });
		},
		[sessionId],
	);
	const dismissFailure = useCallback(
		(switchId: string) => setDismissedFailure({ sessionId, switchId }),
		[sessionId],
	);
	const transientSuccessSwitchId =
		transientSuccess && transientSuccess.sessionId === sessionId
			? transientSuccess.switchId
			: undefined;
	const dismissedFailureSwitchId =
		dismissedFailure && dismissedFailure.sessionId === sessionId
			? dismissedFailure.switchId
			: undefined;
	// Retirement is what prevents a later, unrelated controller outage from
	// reinterpreting this completed history row as a takeover still in progress.
	useEffect(() => {
		if (!transientSuccessSwitchId) return;
		const timer = window.setTimeout(() => {
			retire(transientSuccessSwitchId);
			setTransientSuccess((current) =>
				current &&
				current.sessionId === sessionId &&
				current.switchId === transientSuccessSwitchId
					? undefined
					: current,
			);
		}, 3_000);
		return () => window.clearTimeout(timer);
	}, [retire, sessionId, transientSuccessSwitchId]);

	// History is newest-first. Only its newest terminal row can close the live
	// lifecycle; an unobserved newer outcome suppresses older observed outcomes.
	const latestTerminalSwitch = agentSwitches.find(isTerminalAgentSwitch);
	const observedTerminalSwitch =
		latestTerminalSwitch && isObserved(latestTerminalSwitch.id)
			? latestTerminalSwitch
			: undefined;

	return {
		dismissFailure,
		dismissedFailureSwitchId,
		isObserved,
		isRetired,
		markObserved,
		observedTerminalSwitch,
		retire,
		settle,
		transientSuccessSwitchId,
	};
}
