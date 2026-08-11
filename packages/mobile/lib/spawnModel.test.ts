import { describe, expect, it } from "vitest";
import { modelOverride, resolveSpawnModel, spawnModelSourceChanged } from "./spawnModel";

describe("spawn model resolution", () => {
	it("prefers the project worker model for its configured worker agent", () => {
		expect(resolveSpawnModel({
			selectedAgent: "codex",
			projectWorkerAgent: "codex",
			projectWorkerModel: "gpt-5",
			catalogDefault: "gpt-5.4",
		})).toBe("gpt-5");
	});

	it("uses the selected agent catalog default instead of another agent's project model", () => {
		expect(resolveSpawnModel({
			selectedAgent: "claude-code",
			projectWorkerAgent: "codex",
			projectWorkerModel: "gpt-5",
			catalogDefault: "sonnet",
		})).toBe("sonnet");
	});

	it("leaves automatic selection empty when neither source names a model", () => {
		expect(resolveSpawnModel({ selectedAgent: "codex" })).toBe("");
	});

	it("sends only a touched value that differs from the resolved default", () => {
		expect(modelOverride("opus", "sonnet", true)).toBe("opus");
		expect(modelOverride("sonnet", "sonnet", true)).toBeUndefined();
		expect(modelOverride("opus", "sonnet", false)).toBeUndefined();
	});

	it("reloads the model catalog only when its project or agent source changes", () => {
		expect(spawnModelSourceChanged(
			{ projectId: "project-1", agentId: "codex" },
			{ projectId: "project-1", agentId: "codex" },
		)).toBe(false);
		expect(spawnModelSourceChanged(
			{ projectId: "project-1", agentId: "codex" },
			{ projectId: "project-2", agentId: "codex" },
		)).toBe(true);
		expect(spawnModelSourceChanged(
			{ projectId: "project-1", agentId: "codex" },
			{ projectId: "project-1", agentId: "claude-code" },
		)).toBe(true);
	});
});
