import { describe, it, expect } from "vitest";
import type { SessionStatus } from "../types.js";
import { _AdversarialReviewConfigSchema as AdversarialReviewConfigSchema } from "../config.js";
import { buildPhasePrompt } from "../prompt-builder.js";
import { computeAdversarialTransition } from "../lifecycle-manager.js";

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

describe("Adversarial Validation — computeAdversarialTransition", () => {
  it("planning + artifact → reviewing (plan_review) when rounds remain", () => {
    const result = computeAdversarialTransition("planning", undefined, 0, 2, 1, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("reviewing");
      expect(result.nextPhase).toBe("plan_review");
      expect(result.swapTo).toBe("critic");
    }
  });

  it("planning + no artifact → stuck", () => {
    expect(computeAdversarialTransition("planning", undefined, 0, 2, 1, false)).toBe("stuck");
  });

  it("planning + artifact + last round → working (skip review)", () => {
    const result = computeAdversarialTransition("planning", undefined, 1, 2, 1, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("working");
      expect(result.swapTo).toBe("primary");
      expect(result.resume).toBe(true);
    }
  });

  it("reviewing (plan_review) + artifact + rounds remain → planning (bump round)", () => {
    const result = computeAdversarialTransition("reviewing", "plan_review", 0, 2, 1, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("planning");
      expect(result.swapTo).toBe("primary");
      expect(result.bumpRound).toBe(true);
    }
  });

  it("reviewing (plan_review) + artifact + last round → working", () => {
    const result = computeAdversarialTransition("reviewing", "plan_review", 1, 2, 1, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("working");
      expect(result.swapTo).toBe("primary");
      expect(result.resume).toBe(true);
    }
  });

  it("reviewing (code_review) + artifact → working (primary resumes)", () => {
    const result = computeAdversarialTransition("reviewing", "code_review", 0, 2, 1, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("working");
      expect(result.swapTo).toBe("primary");
      expect(result.promptPhase).toBe("working_after_code_review");
    }
  });

  it("reviewing (plan_review) + no artifact → stuck", () => {
    expect(computeAdversarialTransition("reviewing", "plan_review", 0, 2, 1, false)).toBe("stuck");
  });

  it("reviewing (code_review) + no artifact → stuck", () => {
    expect(computeAdversarialTransition("reviewing", "code_review", 0, 2, 1, false)).toBe("stuck");
  });

  it("reviewing (code_review) + artifact + rounds remain → working (bump round)", () => {
    const result = computeAdversarialTransition("reviewing", "code_review", 0, 2, 2, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("working");
      expect(result.swapTo).toBe("primary");
      expect(result.bumpRound).toBe(true);
      expect(result.promptPhase).toBe("working_after_code_review");
    }
  });

  it("non-adversarial status returns null", () => {
    expect(computeAdversarialTransition("working", undefined, 0, 2, 1, true)).toBeNull();
  });
});
