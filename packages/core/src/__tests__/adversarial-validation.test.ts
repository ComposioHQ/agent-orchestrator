import { describe, it, expect } from "vitest";
import type { SessionStatus } from "../types.js";
import { _AdversarialReviewConfigSchema as AdversarialReviewConfigSchema } from "../config.js";
import { buildPhasePrompt } from "../prompt-builder.js";

describe("Adversarial Validation — Types", () => {
  it("SessionStatus includes planning and reviewing", () => {
    const planning: SessionStatus = "planning";
    const reviewing: SessionStatus = "reviewing";
    expect(planning).toBe("planning");
    expect(reviewing).toBe("reviewing");
  });
});

describe("Adversarial Validation — Config (Zod)", () => {
  it("accepts valid config and applies defaults", () => {
    const result = AdversarialReviewConfigSchema.safeParse({
      enabled: true,
      critic: { agent: "codex" },
    });
    expect(result.success).toBe(true);
  });

  it("applies defaults when plan/code provided without maxRounds", () => {
    const result = AdversarialReviewConfigSchema.safeParse({
      enabled: true,
      critic: { agent: "codex" },
      plan: { enabled: true },
      code: { enabled: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plan?.maxRounds).toBe(2);
      expect(result.data.code?.maxRounds).toBe(1);
    }
  });

  it("rejects when critic.agent is missing", () => {
    const result = AdversarialReviewConfigSchema.safeParse({
      enabled: true,
      critic: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects when maxRounds is 0", () => {
    const result = AdversarialReviewConfigSchema.safeParse({
      enabled: true,
      critic: { agent: "codex" },
      plan: { enabled: true, maxRounds: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts disabled config", () => {
    const result = AdversarialReviewConfigSchema.safeParse({
      enabled: false,
      critic: { agent: "codex" },
    });
    expect(result.success).toBe(true);
  });
});

describe("Adversarial Validation — Phase Prompts", () => {
  it("planning round 0 instructs to write plan.md and exit", () => {
    const prompt = buildPhasePrompt({ phase: "planning", round: 0, maxRounds: 2 });
    expect(prompt).toContain(".ao/adversarial/plan.md");
    expect(prompt).toContain("Do not write any code");
    expect(prompt).toContain("Exit when");
  });

  it("planning round > 0 references critique file", () => {
    const prompt = buildPhasePrompt({ phase: "planning", round: 1, maxRounds: 2 });
    expect(prompt).toContain("plan.critique.md");
    expect(prompt).toContain("revised");
  });

  it("plan_review includes startup ritual", () => {
    const prompt = buildPhasePrompt({ phase: "plan_review", round: 0, maxRounds: 2 });
    expect(prompt).toContain("git log");
    expect(prompt).toContain("plan.md");
    expect(prompt).toContain("plan.critique.md");
    expect(prompt).toContain("Do not modify");
    expect(prompt).toContain("Exit");
  });

  it("working phase references plan and includes test checkpoint", () => {
    const prompt = buildPhasePrompt({ phase: "working", round: 0, maxRounds: 1 });
    expect(prompt).toContain("plan.md");
    expect(prompt).toContain("test");
  });

  it("working phase after code review references critique", () => {
    const prompt = buildPhasePrompt({ phase: "working_after_code_review", round: 0, maxRounds: 1 });
    expect(prompt).toContain("code.critique.md");
  });

  it("code_review includes startup ritual and diff instruction", () => {
    const prompt = buildPhasePrompt({ phase: "code_review", round: 0, maxRounds: 1 });
    expect(prompt).toContain("git log");
    expect(prompt).toContain("git diff");
    expect(prompt).toContain("code.critique.md");
    expect(prompt).toContain("Do not modify any source");
    expect(prompt).toContain("Exit");
  });
});
