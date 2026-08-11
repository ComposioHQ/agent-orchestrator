import { describe, expect, it } from "vitest";
import type { AgentSwitch } from "./useAgentSwitches";
import {
	agentSwitchesRefetchInterval,
	findActiveAgentSwitch,
	findRecoveryRequiredAgentSwitch,
} from "./useAgentSwitches";

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

describe("agentSwitchesRefetchInterval", () => {
	it.each([
		["polls an ordinary active switch", {}, 1_000],
		["stops eager polling when a durable recovery marker is present", { errorCode: "target_start_unconfirmed" }, false],
		["does not poll terminal history", { state: "completed" }, false],
		["keeps polling a protected future state", { state: "future_phase" }, 1_000],
	] as const)("%s", (_name, overrides, expected) => {
		expect(agentSwitchesRefetchInterval([switchRecord(overrides)])).toBe(expected);
	});
});

describe("durable agent switch selection", () => {
	it("keeps an ordinary active row separate from static recovery", () => {
		const recovery = switchRecord({ errorCode: "target_start_unconfirmed", id: "recovery" });
		const active = switchRecord({ id: "active", state: "delivering_context" });

		expect(findActiveAgentSwitch([recovery, active])).toBe(active);
		expect(findRecoveryRequiredAgentSwitch([recovery, active])).toBe(recovery);
	});
});
