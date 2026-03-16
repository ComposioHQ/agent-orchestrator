import { describe, expect, it } from "vitest";
import { isOrchestratorSession } from "../types.js";

describe("isOrchestratorSession", () => {
  it("detects orchestrators by explicit role metadata", () => {
    expect(
      isOrchestratorSession({
        id: "app-control",
        metadata: { role: "orchestrator" },
      }),
    ).toBe(true);
  });

  it("falls back to orchestrator naming for legacy sessions", () => {
    expect(isOrchestratorSession({ id: "app-orchestrator", metadata: {} })).toBe(true);
  });

  it("does not classify worker sessions as orchestrators", () => {
    expect(isOrchestratorSession({ id: "app-7", metadata: { role: "worker" } })).toBe(false);
  });
});
