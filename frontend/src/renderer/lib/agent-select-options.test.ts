import { describe, expect, it } from "vitest";
import { buildRankedAgentOptions } from "./agent-select-options";

const priorityRank = new Map([
	["claude-code", 0],
	["codex", 1],
]);

describe("buildRankedAgentOptions", () => {
	it("ranks selectable agents by frequency before the static cold-start priority", () => {
		const agents = [
			{ id: "claude-code", label: "Claude Code", authStatus: "authorized" as const, usageCount: 1 },
			{ id: "codex", label: "Codex", authStatus: "authorized" as const, usageCount: 4 },
		];

		const options = buildRankedAgentOptions({
			supported: agents,
			installed: agents,
			authorized: agents,
			priorityRank,
			fallbackAgents: [],
		});

		expect(options.map((agent) => agent.id)).toEqual(["codex", "claude-code"]);
	});

	it("uses most recent usage to break frequency ties", () => {
		const agents = [
			{
				id: "claude-code",
				label: "Claude Code",
				authStatus: "authorized" as const,
				usageCount: 2,
				lastUsedAt: "2026-08-18T10:00:00Z",
			},
			{
				id: "codex",
				label: "Codex",
				authStatus: "authorized" as const,
				usageCount: 2,
				lastUsedAt: "2026-08-19T10:00:00Z",
			},
		];

		const options = buildRankedAgentOptions({
			supported: agents,
			installed: agents,
			authorized: agents,
			priorityRank,
			fallbackAgents: [],
		});

		expect(options.map((agent) => agent.id)).toEqual(["codex", "claude-code"]);
	});

	it("keeps unavailable agents below selectable agents regardless of usage", () => {
		const supported = [
			{ id: "claude-code", label: "Claude Code", usageCount: 1 },
			{ id: "codex", label: "Codex", usageCount: 10 },
		];

		const options = buildRankedAgentOptions({
			supported,
			installed: [{ ...supported[0], authStatus: "authorized" as const }],
			authorized: [{ ...supported[0], authStatus: "authorized" as const }],
			priorityRank,
			fallbackAgents: [],
		});

		expect(options.map((agent) => agent.id)).toEqual(["claude-code", "codex"]);
	});
});
