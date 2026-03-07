import { describe, it, expect } from "vitest";
import { parseDispatchLabels } from "../session-manager.js";

describe("parseDispatchLabels", () => {
  it("parses a dispatch: label", () => {
    const result = parseDispatchLabels(["dispatch:cli-single", "bug", "priority:high"]);
    expect(result).toEqual({ dispatch: "dispatch:cli-single" });
  });

  it("parses a mode: label", () => {
    const result = parseDispatchLabels(["mode:plan-first", "enhancement"]);
    expect(result).toEqual({ mode: "mode:plan-first" });
  });

  it("parses a model: label", () => {
    const result = parseDispatchLabels(["model:sonnet", "frontend"]);
    expect(result).toEqual({ model: "model:sonnet" });
  });

  it("parses all three prefix types together", () => {
    const result = parseDispatchLabels([
      "dispatch:cli-team-3",
      "mode:direct",
      "model:opus",
      "cat:platform",
    ]);
    expect(result).toEqual({
      dispatch: "dispatch:cli-team-3",
      mode: "mode:direct",
      model: "model:opus",
    });
  });

  it("returns empty object for empty labels", () => {
    expect(parseDispatchLabels([])).toEqual({});
  });

  it("returns empty object when no dispatch labels present", () => {
    const result = parseDispatchLabels(["bug", "priority:high", "cat:platform"]);
    expect(result).toEqual({});
  });

  it("first-wins when duplicate prefixes exist", () => {
    const result = parseDispatchLabels([
      "dispatch:cli-single",
      "dispatch:cli-team-3",
      "model:sonnet",
      "model:opus",
    ]);
    expect(result).toEqual({
      dispatch: "dispatch:cli-single",
      model: "model:sonnet",
    });
  });

  it("metadata is passed through to AgentLaunchConfig in spawn", () => {
    // This test validates the shape — the integration with spawn() is
    // tested in session-manager.test.ts
    const labels = ["dispatch:cli-single", "mode:direct", "model:sonnet"];
    const metadata = parseDispatchLabels(labels);
    expect(metadata).toHaveProperty("dispatch");
    expect(metadata).toHaveProperty("mode");
    expect(metadata).toHaveProperty("model");
    expect(Object.keys(metadata)).toHaveLength(3);
  });
});
