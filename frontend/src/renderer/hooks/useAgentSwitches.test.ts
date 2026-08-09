import { describe, expect, it } from "vitest";
import type { AgentSwitch } from "./useAgentSwitches";
import { agentSwitchesRefetchInterval } from "./useAgentSwitches";

function switchRecord(overrides: Partial<AgentSwitch> = {}): AgentSwitch {
	return {
		agentHandoffStatus: "not_attempted",
		fromHarness: "claude-code",
		id: "switch-1",
		requestedAt: "2026-06-10T00:00:00Z",
		semanticHandoffIncluded: true,
		sessionId: "session-1",
		state: "starting_target",
		targetHarness: "codex",
		updatedAt: "2026-06-10T00:00:01Z",
		...overrides,
	};
}

describe("agentSwitchesRefetchInterval", () => {
	it.each([
		["polls an ordinary active switch", {}, 1_000],
		["stops eager polling when a durable recovery marker is present", { errorCode: "target_start_unconfirmed" }, false],
		["does not poll terminal history", { state: "completed" }, false],
	] as const)("%s", (_name, overrides, expected) => {
		expect(agentSwitchesRefetchInterval([switchRecord(overrides)])).toBe(expected);
	});
});
