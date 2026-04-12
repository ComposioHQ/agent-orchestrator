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
    expect(normalizeOrchestratorSessionStrategy("new")).toBe("new");
  });

  it("maps legacy aliases to canonical values (bypass callers)", () => {
    // Legacy values are normally normalized by the Zod transform in config.ts,
    // but the runtime function still handles them as a safety net for callers
    // that bypass config parsing (e.g. direct metadata reads).
    expect(normalizeOrchestratorSessionStrategy("kill-previous" as "delete")).toBe("delete");
    expect(normalizeOrchestratorSessionStrategy("delete-new" as "delete")).toBe("delete");
    expect(normalizeOrchestratorSessionStrategy("ignore-new" as "ignore")).toBe("ignore");
  });
});
