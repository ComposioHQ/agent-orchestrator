/**
 * Tests for dashboard types and attention level classification
 */

import { describe, it, expect } from "vitest";
import {
  getAttentionLevel,
  isPRRateLimited,
  TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES,
  NON_RESTORABLE_STATUSES,
  type DashboardSession,
  type DashboardPR,
} from "../types";
import {
  TERMINAL_STATUSES as CORE_TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES as CORE_TERMINAL_ACTIVITIES,
  NON_RESTORABLE_STATUSES as CORE_NON_RESTORABLE_STATUSES,
} from "@composio/ao-core/types";

// Helper to create a minimal DashboardSession for testing
function createSession(overrides?: Partial<DashboardSession>): DashboardSession {
  return {
    id: "test-1",
    projectId: "test",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    summary: "Test session",
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    ...overrides,
  };
}

describe("getAttentionLevel", () => {
  describe("done state", () => {
    it("should return 'done' for merged status", () => {
      const session = createSession({ status: "merged" });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should return 'done' for killed status", () => {
      const session = createSession({ status: "killed" });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should return 'done' for cleanup status", () => {
      const session = createSession({ status: "cleanup" });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should return 'done' for done status", () => {
      const session = createSession({ status: "done" });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should return 'done' for terminated status", () => {
      const session = createSession({ status: "terminated" });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should return 'done' for merged PR regardless of session status", () => {
      const session = createSession({
        status: "working",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "merged",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "approved",
          mergeability: {
            mergeable: true,
            ciPassing: true,
            approved: true,
            noConflicts: true,
            blockers: [],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should return 'done' for closed PR regardless of session status", () => {
      const session = createSession({
        status: "working",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "closed",
          additions: 10,
          deletions: 5,
          ciStatus: "none",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: false,
            approved: false,
            noConflicts: true,
            blockers: [],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("done");
    });
  });

  describe("merge state", () => {
    it("should return 'merge' for mergeable status", () => {
      const session = createSession({ status: "mergeable" });
      expect(getAttentionLevel(session)).toBe("merge");
    });

    it("should return 'merge' for approved status", () => {
      const session = createSession({ status: "approved" });
      expect(getAttentionLevel(session)).toBe("merge");
    });

    it("should return 'merge' when PR is mergeable", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "approved",
          mergeability: {
            mergeable: true,
            ciPassing: true,
            approved: true,
            noConflicts: true,
            blockers: [],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("merge");
    });
  });

  describe("respond state", () => {
    it("should return 'respond' for waiting_input activity", () => {
      const session = createSession({ activity: "waiting_input" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("should return 'respond' for blocked activity", () => {
      const session = createSession({ activity: "blocked" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("should return 'respond' for needs_input status", () => {
      const session = createSession({ status: "needs_input" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("should return 'respond' for stuck status", () => {
      const session = createSession({ status: "stuck" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("should return 'respond' for errored status", () => {
      const session = createSession({ status: "errored" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("should return 'respond' for exited activity", () => {
      const session = createSession({ activity: "exited" });
      expect(getAttentionLevel(session)).toBe("respond");
    });
  });

  describe("review state", () => {
    it("should return 'review' for ci_failed status", () => {
      const session = createSession({ status: "ci_failed" });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("should return 'review' for changes_requested status", () => {
      const session = createSession({ status: "changes_requested" });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("should return 'review' when PR has failing CI", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "failing",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: false,
            approved: false,
            noConflicts: true,
            blockers: ["CI is failing"],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("should return 'review' when PR has changes requested", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "changes_requested",
          mergeability: {
            mergeable: false,
            ciPassing: true,
            approved: false,
            noConflicts: true,
            blockers: ["Changes requested in review"],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("should return 'review' when PR has merge conflicts", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: true,
            approved: false,
            noConflicts: false,
            blockers: ["Merge conflicts"],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("review");
    });
  });

  describe("pending state", () => {
    it("should return 'pending' for review_pending status", () => {
      const session = createSession({ status: "review_pending" });
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("should return 'pending' when PR has unresolved threads", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: true,
            approved: false,
            noConflicts: true,
            blockers: [],
          },
          unresolvedThreads: 3,
          unresolvedComments: [{ url: "", path: "", author: "reviewer", body: "comment" }],
        },
      });
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("should return 'pending' when PR is waiting for review", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "pending",
          mergeability: {
            mergeable: false,
            ciPassing: true,
            approved: false,
            noConflicts: true,
            blockers: ["Review required"],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("should not flag draft PRs as pending", () => {
      const session = createSession({
        status: "working",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: true,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: true,
            approved: false,
            noConflicts: true,
            blockers: ["PR is still a draft"],
          },
          unresolvedThreads: 2,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("working");
    });
  });

  describe("working state", () => {
    it("should return 'working' for spawning status", () => {
      const session = createSession({ status: "spawning" });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("should return 'working' for working status with active activity", () => {
      const session = createSession({
        status: "working",
        activity: "active",
      });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("should return 'working' for idle agent", () => {
      const session = createSession({
        status: "working",
        activity: "idle",
      });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("should return 'working' for session with draft PR", () => {
      const session = createSession({
        status: "working",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: true,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "none",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: false,
            approved: false,
            noConflicts: true,
            blockers: ["PR is still a draft"],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("working");
    });
  });
});

// Helper to create a PR with specific blockers
function createPR(blockers: string[]): DashboardPR {
  return {
    number: 1,
    url: "https://github.com/test/repo/pull/1",
    title: "Test PR",
    owner: "test",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    state: "open",
    additions: 10,
    deletions: 5,
    ciStatus: "none",
    ciChecks: [],
    reviewDecision: "none",
    mergeability: {
      mergeable: false,
      ciPassing: false,
      approved: false,
      noConflicts: true,
      blockers,
    },
    unresolvedThreads: 0,
    unresolvedComments: [],
  };
}

describe("isPRRateLimited", () => {
  it("returns false when blockers is empty", () => {
    expect(isPRRateLimited(createPR([]))).toBe(false);
  });

  it("returns false for unrelated blockers", () => {
    expect(isPRRateLimited(createPR(["Merge conflicts", "CI is failing"]))).toBe(false);
  });

  it("returns true when blockers includes the rate-limit sentinel", () => {
    expect(isPRRateLimited(createPR(["API rate limited or unavailable"]))).toBe(true);
  });

  it("returns true when blockers includes 'Data not loaded' (enrichment timeout)", () => {
    // When the server-side 4s enrichment timeout fires, the PR is left with
    // this default blocker. Treating it as stale prevents false-positive alerts.
    expect(isPRRateLimited(createPR(["Data not loaded"]))).toBe(true);
  });

  it("returns true when rate-limit sentinel is among multiple blockers", () => {
    expect(isPRRateLimited(createPR(["Something else", "API rate limited or unavailable"]))).toBe(true);
  });

  it("getAttentionLevel treats Data-not-loaded PRs as working (not review/pending)", () => {
    // A session whose PR enrichment timed out should NOT be classified as
    // needing attention (its ciStatus=none, reviewDecision=none are defaults).
    const session = createSession({
      status: "pr_open",
      pr: createPR(["Data not loaded"]),
    });
    expect(getAttentionLevel(session)).toBe("working");
  });

  it("getAttentionLevel treats rate-limited PRs as working (not review/pending)", () => {
    const session = createSession({
      status: "pr_open",
      pr: createPR(["API rate limited or unavailable"]),
    });
    expect(getAttentionLevel(session)).toBe("working");
  });
});

describe("constants sync with core", () => {
  it("TERMINAL_STATUSES matches core", () => {
    expect(TERMINAL_STATUSES).toBe(CORE_TERMINAL_STATUSES);
  });

  it("TERMINAL_ACTIVITIES matches core", () => {
    expect(TERMINAL_ACTIVITIES).toBe(CORE_TERMINAL_ACTIVITIES);
  });

  it("NON_RESTORABLE_STATUSES matches core", () => {
    expect(NON_RESTORABLE_STATUSES).toBe(CORE_NON_RESTORABLE_STATUSES);
  });
});
