import { describe, expect, it } from "vitest";
import { validateWorkPlan, WorkPlanValidationError } from "../work-plan.js";
import type { WorkPlan } from "../types.js";

function makeValidPlan(): WorkPlan {
  return {
    schemaVersion: "1.0",
    goal: "Ship strict planning schema",
    assumptions: ["Core package is available"],
    acceptance: {
      definitionOfDone: "All acceptance checks pass",
      checks: [
        {
          id: "ac-tests",
          description: "Tests cover valid and invalid plan cases",
          verification: "vitest",
          required: true,
        },
        {
          id: "ac-validator",
          description: "Validator rejects invalid references",
          verification: "unit assertions",
          required: true,
        },
      ],
    },
    tasks: [
      {
        id: "task-schema",
        title: "Add plan types",
        description: "Add WorkPlan, TaskNode, and AcceptanceContract",
        priority: "critical",
        dependencies: [],
        risks: ["Type drift"],
        acceptanceChecks: ["ac-validator"],
      },
      {
        id: "task-tests",
        title: "Add tests",
        description: "Cover valid and invalid plans",
        priority: "high",
        dependencies: ["task-schema"],
        risks: [],
        acceptanceChecks: ["ac-tests", "ac-validator"],
      },
    ],
  };
}

describe("validateWorkPlan", () => {
  it("accepts a valid plan", () => {
    const result = validateWorkPlan(makeValidPlan());
    expect(result.goal).toBe("Ship strict planning schema");
    expect(result.tasks).toHaveLength(2);
  });

  it("returns actionable errors for missing required fields", () => {
    expect.assertions(3);

    try {
      validateWorkPlan({
        schemaVersion: "1.0",
        goal: "Missing fields plan",
        tasks: [{}],
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WorkPlanValidationError);
      const message = (err as Error).message;
      expect(message).toContain("tasks[0].id: is required");
      expect(message).toContain("acceptance: is required");
    }
  });

  it("rejects unknown task dependencies with explicit IDs", () => {
    const plan = makeValidPlan();
    plan.tasks[1]!.dependencies = ["task-schema", "task-missing"];

    expect(() => validateWorkPlan(plan)).toThrow(WorkPlanValidationError);
    expect(() => validateWorkPlan(plan)).toThrow(/unknown task dependency "task-missing"/);
  });

  it("rejects unknown acceptance checks on tasks", () => {
    const plan = makeValidPlan();
    plan.tasks[0]!.acceptanceChecks = ["ac-unknown"];

    expect(() => validateWorkPlan(plan)).toThrow(/unknown acceptance check "ac-unknown"/);
  });

  it("rejects duplicate task IDs", () => {
    const plan = makeValidPlan();
    plan.tasks.push({
      id: "task-schema",
      title: "Duplicate id",
      description: "Should fail",
      priority: "low",
      dependencies: [],
      risks: [],
      acceptanceChecks: ["ac-tests"],
    });

    expect(() => validateWorkPlan(plan)).toThrow(/duplicate task id "task-schema"/);
  });

  it("does not check dependency cycles in this validator", () => {
    const plan = makeValidPlan();
    plan.tasks = [
      {
        id: "task-a",
        title: "Task A",
        description: "Depends on B",
        priority: "high",
        dependencies: ["task-b"],
        risks: [],
        acceptanceChecks: ["ac-validator"],
      },
      {
        id: "task-b",
        title: "Task B",
        description: "Depends on A",
        priority: "medium",
        dependencies: ["task-a"],
        risks: [],
        acceptanceChecks: ["ac-tests"],
      },
    ];

    expect(() => validateWorkPlan(plan)).not.toThrow();
  });
});
