import { describe, expect, it } from "vitest";
import type { AgentModelCatalog } from "../hooks/useAgentModelsQuery";
import { reviewerModelOptions } from "./ReviewerSelect";

const qwenCatalog = {
	agentId: "qwen",
	allowCustom: true,
	customModelEntry: "direct",
	fetchedAt: "2026-09-03T00:00:00Z",
	models: [{ id: "qwen3-coder", label: "Qwen 3 Coder" }],
	selectionMode: "text",
	source: "provider",
	stale: false,
} satisfies AgentModelCatalog;

describe("reviewerModelOptions", () => {
	it("adds the opt-in native review mode alongside Qwen models", () => {
		expect(reviewerModelOptions("qwen", qwenCatalog, "Native review")).toEqual([
			{ kind: "model", label: "Qwen 3 Coder", value: "qwen3-coder" },
			{ kind: "mode", label: "Native review", value: "native-review" },
		]);
	});

	it("does not expose Qwen native review for other reviewer adapters", () => {
		expect(reviewerModelOptions("claude-code", undefined, "Native review")).toEqual([]);
	});
});
