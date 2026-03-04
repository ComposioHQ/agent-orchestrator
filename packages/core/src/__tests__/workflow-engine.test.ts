import { describe, expect, it } from "vitest";
import { WorkflowEngine, parseWorkflowPieceYaml } from "../workflow-engine.js";

describe("WorkflowEngine", () => {
  it("executes transitions and completes", async () => {
    const piece = parseWorkflowPieceYaml(`
name: plan-implement-review
initial_movement: plan
max_movements: 6
movements:
  - name: plan
    rules:
      - condition: planning_done
        next: implement
  - name: implement
    rules:
      - condition: implementation_done
        next: review
  - name: review
    rules:
      - condition: approved
        next: COMPLETE
      - condition: needs_fix
        next: implement
`);
    const engine = new WorkflowEngine(piece);
    const outputs = ["planning_done", "implementation_done", "approved"];
    const result = await engine.run({
      executeMovement: async () => ({ matchedCondition: outputs.shift() }),
    });
    expect(result.status).toBe("complete");
    expect(result.history).toEqual(["plan", "implement", "review"]);
  });

  it("supports rule evaluation callback when movement does not return matched condition", async () => {
    const piece = parseWorkflowPieceYaml(`
name: minimal
initial_movement: review
movements:
  - name: review
    rules:
      - condition: approved
        next: COMPLETE
`);
    const engine = new WorkflowEngine(piece);
    const result = await engine.run({
      executeMovement: async () => ({}),
      evaluateCondition: async (condition) => condition === "approved",
    });
    expect(result.status).toBe("complete");
  });

  it("aborts when same movement loops beyond threshold", async () => {
    const piece = parseWorkflowPieceYaml(`
name: loopy
initial_movement: review
loop_threshold: 2
max_movements: 10
movements:
  - name: review
    rules:
      - condition: retry
        next: review
`);
    const engine = new WorkflowEngine(piece);
    const result = await engine.run({
      executeMovement: async () => ({ matchedCondition: "retry" }),
    });
    expect(result.status).toBe("aborted");
    expect(result.history).toEqual(["review", "review", "review"]);
  });
});

