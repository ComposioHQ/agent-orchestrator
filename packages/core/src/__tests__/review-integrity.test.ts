import { describe, expect, it } from "vitest";
import {
  createResolutionRecord,
  evaluateMergeGuard,
  evaluateReviewIntegrity,
  type ReviewThreadSnapshot,
  type ResolutionRecord,
} from "../review-integrity.js";

function thread(overrides: Partial<ReviewThreadSnapshot>): ReviewThreadSnapshot {
  return {
    prNumber: 42,
    threadId: "THR_1",
    source: "human",
    bodyHash: "abc123",
    severity: "medium",
    status: "resolved",
    capturedAt: new Date("2026-03-12T00:00:00Z"),
    ...overrides,
  };
}

function verifiedRecord(overrides: Partial<ResolutionRecord> = {}): ResolutionRecord {
  return {
    id: "resolution_1",
    createdAt: new Date("2026-03-12T00:00:00Z"),
    ...createResolutionRecord({
      prNumber: 42,
      threadId: "THR_1",
      resolutionType: "fixed",
      actorType: "agent",
      actorId: "ao",
      fixCommitSha: "abc",
      evidence: {
        changedFiles: ["src/a.ts"],
        testCommands: ["pnpm test"],
        testResults: ["pass"],
      },
    }),
    verificationStatus: "pass",
    ...overrides,
  };
}

describe("review integrity evaluator", () => {
  it("fails when unresolved threads exist", () => {
    const result = evaluateReviewIntegrity([thread({ status: "open" })], new Map());
    expect(result.status).toBe("fail");
    expect(result.unresolvedThreadCount).toBe(1);
    expect(result.blockers[0]?.code).toBe("THREAD_UNRESOLVED");
  });

  it("fails when resolved thread has no resolution record", () => {
    const result = evaluateReviewIntegrity([thread({ status: "resolved" })], new Map());
    expect(result.status).toBe("fail");
    expect(result.unverifiedResolvedThreadCount).toBe(1);
    expect(result.blockers[0]?.code).toBe("MISSING_RESOLUTION");
  });

  it("fails when fixed record has no test evidence", () => {
    const record = verifiedRecord({
      evidence: {
        changedFiles: ["src/a.ts"],
        testCommands: ["pnpm test"],
        testResults: [],
      },
    });
    const records = new Map([["THR_1", record]]);
    const result = evaluateReviewIntegrity([thread({ status: "resolved" })], records);
    expect(result.status).toBe("fail");
    expect(result.blockers.some((b) => b.code === "INVALID_RESOLUTION")).toBe(true);
  });

  it("passes when all resolved threads are verified and valid", () => {
    const records = new Map([["THR_1", verifiedRecord()]]);
    const result = evaluateReviewIntegrity([thread({ status: "resolved" })], records);
    expect(result.status).toBe("pass");
    expect(result.blockers).toHaveLength(0);
  });

  it("fails on verification drift when head sha changed", () => {
    const records = new Map([
      [
        "THR_1",
        verifiedRecord({
          verifiedHeadSha: "oldsha",
        }),
      ],
    ]);
    const result = evaluateReviewIntegrity([thread({ status: "resolved" })], records, {
      currentHeadSha: "newsha",
    });
    expect(result.status).toBe("fail");
    expect(result.blockers.some((b) => b.code === "VERIFICATION_DRIFT")).toBe(true);
  });

  it("classifies mixed validation blockers individually", () => {
    const records = new Map([
      [
        "THR_1",
        verifiedRecord({
          evidence: {
            changedFiles: ["src/a.ts"],
            testCommands: ["pnpm test"],
            testResults: [],
          },
          verifiedHeadSha: "oldsha",
        }),
      ],
    ]);
    const result = evaluateReviewIntegrity([thread({ status: "resolved" })], records, {
      currentHeadSha: "newsha",
    });
    expect(result.status).toBe("fail");
    expect(result.blockers.some((b) => b.code === "VERIFICATION_DRIFT")).toBe(true);
    expect(result.blockers.some((b) => b.code === "INVALID_RESOLUTION")).toBe(true);
  });
});

describe("merge guard evaluator", () => {
  it("fails when required checks are missing or failing", () => {
    const integrity = evaluateReviewIntegrity([thread({ status: "resolved" })], new Map());
    const result = evaluateMergeGuard({
      integrity,
      requiredChecks: ["review-integrity", "ao/merge-guard", "test"],
      checkConclusions: new Map([
        ["review-integrity", "failed"],
        ["ao/merge-guard", "passed"],
      ]),
    });
    expect(result.allowMerge).toBe(false);
    expect(result.blockers.some((b) => b.code === "REQUIRED_CHECK_NOT_PASSING")).toBe(true);
    expect(result.blockers.some((b) => b.code === "REQUIRED_CHECK_MISSING")).toBe(true);
  });

  it("passes when integrity passes and required checks pass", () => {
    const integrity = evaluateReviewIntegrity(
      [thread({ status: "resolved" })],
      new Map([["THR_1", verifiedRecord()]]),
    );
    const result = evaluateMergeGuard({
      integrity,
      requiredChecks: ["review-integrity", "ao/merge-guard"],
      checkConclusions: new Map([
        ["review-integrity", "passed"],
        ["ao/merge-guard", "passed"],
      ]),
    });
    expect(result.allowMerge).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });
});
