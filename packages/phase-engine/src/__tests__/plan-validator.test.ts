import { describe, it, expect } from "vitest";
import { validatePlan } from "../plan-validator.js";
import type { Plan, TeamDefinition } from "@composio/ao-core";

const pairTeam: TeamDefinition = {
  description: "Planner + driver",
  phases: ["plan", "validate", "implement", "finalize", "refine"],
  agents: {
    planner: { role: "planner", model: "sonnet" },
    driver: { role: "driver", model: "sonnet" },
  },
};

const validPlan: Plan = {
  summary: "Add auth middleware",
  workUnits: [
    {
      id: "wu-1",
      description: "Implement auth middleware",
      assignedTo: "driver",
      files: ["src/middleware/auth.ts", "src/types/auth.ts"],
      criteria: "Auth middleware validates JWT tokens",
    },
  ],
  sharedFiles: ["src/index.ts"],
  integrateOrder: ["driver"],
};

describe("validatePlan", () => {
  it("accepts a valid plan", () => {
    const result = validatePlan(validPlan, pairTeam);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects plan without summary", () => {
    const plan: Plan = { ...validPlan, summary: "" };
    const result = validatePlan(plan, pairTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "summary")).toBe(true);
  });

  it("rejects plan with no work units", () => {
    const plan: Plan = { ...validPlan, workUnits: [] };
    const result = validatePlan(plan, pairTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "workUnits")).toBe(true);
  });

  it("rejects overlapping file scopes", () => {
    const plan: Plan = {
      ...validPlan,
      workUnits: [
        {
          id: "wu-1",
          description: "Unit 1",
          assignedTo: "driver",
          files: ["src/auth.ts"],
          criteria: "criteria",
        },
        {
          id: "wu-2",
          description: "Unit 2",
          assignedTo: "planner",
          files: ["src/auth.ts"],
          criteria: "criteria",
        },
      ],
      integrateOrder: ["driver", "planner"],
    };
    const result = validatePlan(plan, pairTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("src/auth.ts"))).toBe(true);
  });

  it("rejects shared files in work unit files", () => {
    const plan: Plan = {
      ...validPlan,
      workUnits: [
        {
          id: "wu-1",
          description: "Unit 1",
          assignedTo: "driver",
          files: ["src/index.ts"],
          criteria: "criteria",
        },
      ],
      sharedFiles: ["src/index.ts"],
    };
    const result = validatePlan(plan, pairTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "sharedFiles")).toBe(true);
  });

  it("rejects missing agent in integrateOrder", () => {
    const plan: Plan = {
      ...validPlan,
      integrateOrder: [], // driver is assigned but missing
    };
    const result = validatePlan(plan, pairTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "integrateOrder")).toBe(true);
  });

  it("rejects invalid agent name in assignedTo", () => {
    const plan: Plan = {
      ...validPlan,
      workUnits: [
        {
          id: "wu-1",
          description: "Unit 1",
          assignedTo: "nonexistent",
          files: ["src/auth.ts"],
          criteria: "criteria",
        },
      ],
      integrateOrder: ["nonexistent"],
    };
    const result = validatePlan(plan, pairTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("nonexistent"))).toBe(true);
  });

  it("rejects duplicate work unit IDs", () => {
    const plan: Plan = {
      ...validPlan,
      workUnits: [
        {
          id: "wu-1",
          description: "Unit 1",
          assignedTo: "driver",
          files: ["src/a.ts"],
          criteria: "criteria",
        },
        {
          id: "wu-1",
          description: "Unit 2",
          assignedTo: "driver",
          files: ["src/b.ts"],
          criteria: "criteria",
        },
      ],
    };
    const result = validatePlan(plan, pairTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("Duplicate"))).toBe(true);
  });
});
