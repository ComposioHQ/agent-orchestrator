import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  writePlanArtifact,
  readPlanArtifact,
  writeReviewArtifact,
  readReviewArtifacts,
  isAllApproved,
  getLatestRound,
} from "../review-artifacts.js";

let worktreePath: string;

beforeEach(() => {
  worktreePath = join(tmpdir(), `ao-test-review-artifacts-${randomUUID()}`);
  mkdirSync(worktreePath, { recursive: true });
});

afterEach(() => {
  rmSync(worktreePath, { recursive: true, force: true });
});

describe("plan artifacts", () => {
  it("writes and reads .ao/plan.md", () => {
    const content = "# Plan\n\n- Step 1\n- Step 2\n";
    writePlanArtifact(worktreePath, content);

    expect(readPlanArtifact(worktreePath)).toBe(content);
  });

  it("returns null if plan file does not exist", () => {
    expect(readPlanArtifact(worktreePath)).toBeNull();
  });
});

describe("review artifacts", () => {
  it("writes and reads artifacts for a specific phase/round", () => {
    writeReviewArtifact(worktreePath, {
      phase: "plan_review",
      round: 1,
      role: "architect",
      decision: "approved",
      timestamp: "2026-02-23T10:30:00Z",
      content: "Looks good.",
    });
    writeReviewArtifact(worktreePath, {
      phase: "plan_review",
      round: 1,
      role: "developer",
      decision: "changes_requested",
      timestamp: "2026-02-23T10:31:00Z",
      content: "Need tests.",
    });
    writeReviewArtifact(worktreePath, {
      phase: "code_review",
      round: 1,
      role: "product",
      decision: "approved",
      timestamp: "2026-02-23T10:32:00Z",
      content: "UX looks fine.",
    });

    const round1Plan = readReviewArtifacts(worktreePath, "plan_review", 1);
    expect(round1Plan).toHaveLength(2);
    expect(round1Plan.map((r) => r.role)).toEqual(["architect", "developer"]);
    expect(round1Plan[0]?.decision).toBe("approved");
    expect(round1Plan[1]?.decision).toBe("changes_requested");
    expect(round1Plan[1]?.content).toBe("Need tests.");

    const round1Code = readReviewArtifacts(worktreePath, "code_review", 1);
    expect(round1Code).toHaveLength(1);
    expect(round1Code[0]?.role).toBe("product");
  });

  it("parses malformed headers safely", () => {
    const reviewsDir = join(worktreePath, ".ao", "reviews");
    mkdirSync(reviewsDir, { recursive: true });

    writeFileSync(
      join(reviewsDir, "plan_review-round-2-architect.md"),
      "decision=not-a-valid-decision\nround=abc\nphase=plan_review\nrole=unknown\n---\nBody text\n",
      "utf-8",
    );

    const reviews = readReviewArtifacts(worktreePath, "plan_review", 2);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.decision).toBe("pending");
    expect(reviews[0]?.round).toBe(2);
    expect(reviews[0]?.role).toBe("architect");
  });

  it("uses file identity over header identity fields", () => {
    const reviewsDir = join(worktreePath, ".ao", "reviews");
    mkdirSync(reviewsDir, { recursive: true });

    writeFileSync(
      join(reviewsDir, "plan_review-round-2-developer.md"),
      "decision=approved\nround=99\nphase=code_review\nrole=product\n---\nCanonical identity must come from filename\n",
      "utf-8",
    );

    const reviews = readReviewArtifacts(worktreePath, "plan_review", 2);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.phase).toBe("plan_review");
    expect(reviews[0]?.round).toBe(2);
    expect(reviews[0]?.role).toBe("developer");
  });
});

describe("helpers", () => {
  it("isAllApproved returns true only when all decisions are approved", () => {
    expect(
      isAllApproved([
        {
          phase: "plan_review",
          round: 1,
          role: "architect",
          decision: "approved",
          timestamp: "2026-02-23T10:30:00Z",
          content: "ok",
        },
        {
          phase: "plan_review",
          round: 1,
          role: "developer",
          decision: "approved",
          timestamp: "2026-02-23T10:31:00Z",
          content: "ok",
        },
      ]),
    ).toBe(true);

    expect(
      isAllApproved([
        {
          phase: "plan_review",
          round: 1,
          role: "architect",
          decision: "approved",
          timestamp: "2026-02-23T10:30:00Z",
          content: "ok",
        },
        {
          phase: "plan_review",
          round: 1,
          role: "developer",
          decision: "pending",
          timestamp: "2026-02-23T10:31:00Z",
          content: "pending",
        },
      ]),
    ).toBe(false);

    expect(isAllApproved([])).toBe(false);
  });

  it("getLatestRound returns max round by phase", () => {
    writeReviewArtifact(worktreePath, {
      phase: "plan_review",
      round: 1,
      role: "architect",
      decision: "approved",
      timestamp: "2026-02-23T10:30:00Z",
      content: "ok",
    });
    writeReviewArtifact(worktreePath, {
      phase: "plan_review",
      round: 3,
      role: "developer",
      decision: "approved",
      timestamp: "2026-02-23T10:31:00Z",
      content: "ok",
    });
    writeReviewArtifact(worktreePath, {
      phase: "code_review",
      round: 2,
      role: "product",
      decision: "approved",
      timestamp: "2026-02-23T10:32:00Z",
      content: "ok",
    });

    expect(getLatestRound(worktreePath, "plan_review")).toBe(3);
    expect(getLatestRound(worktreePath, "code_review")).toBe(2);
    expect(getLatestRound(worktreePath, "plan_review")).not.toBe(0);
  });
});
