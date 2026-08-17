import { describe, expect, it } from "vitest";
import { AGENT_LABELS, getAgentIdentity } from "./agents";

describe("DeepSeek agent identity", () => {
	it("uses the DeepSeek display name while preserving the provider ID", () => {
		expect(AGENT_LABELS["deepseek-harness"]).toBe("DeepSeek");
		expect(getAgentIdentity("deepseek-harness")).toMatchObject({
			id: "deepseek-harness",
			label: "DeepSeek",
		});
	});
});
