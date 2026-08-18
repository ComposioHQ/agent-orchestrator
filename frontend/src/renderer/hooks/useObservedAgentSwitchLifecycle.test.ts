import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSwitch } from "./useAgentSwitches";
import { useObservedAgentSwitchLifecycle } from "./useObservedAgentSwitchLifecycle";

function switchRecord(overrides: Partial<AgentSwitch> = {}): AgentSwitch {
	return {
		agentHandoffStatus: "not_attempted",
		fromHarness: "claude-code",
		id: "switch-1",
		state: "starting_target",
		targetHarness: "codex",
		...overrides,
	};
}

describe("useObservedAgentSwitchLifecycle", () => {
	afterEach(() => vi.useRealTimers());

	it("retires a settled lifecycle so its terminal history cannot be selected again", () => {
		vi.useFakeTimers();
		const activeSwitch = switchRecord();
		const completedSwitch = switchRecord({ state: "completed" });
		const { result, rerender } = renderHook(
			({ agentSwitches, candidates }) =>
				useObservedAgentSwitchLifecycle({
					sessionId: "session-1",
					agentSwitches,
					nonterminalCandidates: candidates,
				}),
			{
				initialProps: {
					agentSwitches: [activeSwitch],
					candidates: [activeSwitch],
				},
			},
		);

		rerender({ agentSwitches: [completedSwitch], candidates: [] });
		expect(result.current.observedTerminalSwitch).toBe(completedSwitch);

		act(() => result.current.settle(completedSwitch.id));
		expect(result.current.transientSuccessSwitchId).toBe(completedSwitch.id);
		act(() => vi.advanceTimersByTime(3_000));
		rerender({ agentSwitches: [completedSwitch], candidates: [] });

		expect(result.current.observedTerminalSwitch).toBeUndefined();
		expect(result.current.isObserved(completedSwitch.id)).toBe(false);
		expect(result.current.isRetired(completedSwitch.id)).toBe(true);
	});

	it("starts fresh when the mounted session changes", () => {
		const activeSwitch = switchRecord();
		const { result, rerender } = renderHook(
			({ sessionId, candidates }) =>
				useObservedAgentSwitchLifecycle({
					sessionId,
					agentSwitches: [],
					nonterminalCandidates: candidates,
				}),
			{
				initialProps: { sessionId: "session-1", candidates: [activeSwitch] },
			},
		);
		expect(result.current.isObserved(activeSwitch.id)).toBe(true);

		act(() => result.current.retire(activeSwitch.id));
		rerender({ sessionId: "session-2", candidates: [] });

		expect(result.current.isObserved(activeSwitch.id)).toBe(false);
		expect(result.current.isRetired(activeSwitch.id)).toBe(false);
	});
});
