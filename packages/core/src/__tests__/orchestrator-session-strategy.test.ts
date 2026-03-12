import { describe, expect, it } from "vitest";
import { normalizeOrchestratorSessionStrategy } from "../orchestrator-session-strategy.js";

describe("normalizeOrchestratorSessionStrategy", () => {
  it("defaults to reuse when strategy is unset", () => {
    expect(normalizeOrchestratorSessionStrategy(undefined)).toBe("reuse");
  });

  it("returns canonical strategies unchanged", () => {
    expect(normalizeOrchestratorSessionStrategy("reuse")).toBe("reuse");
    expect(normalizeOrchestratorSessionStrategy("delete")).toBe("delete");
    expect(normalizeOrchestratorSessionStrategy("ignore")).toBe("ignore");
  });

  it("maps legacy aliases to canonical values", () => {
    expect(normalizeOrchestratorSessionStrategy("kill-previous")).toBe("delete");
    expect(normalizeOrchestratorSessionStrategy("delete-new")).toBe("delete");
    expect(normalizeOrchestratorSessionStrategy("ignore-new")).toBe("ignore");
  });
});
