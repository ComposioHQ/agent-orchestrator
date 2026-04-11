/**
 * Tests for dashboard types and attention level classification
 */

import { describe, it, expect } from "vitest";
import {
  getAttentionLevel,
  isPRMergeReady,
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
} from "@aoagents/ao-core/types";

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

    it("should ignore metadata attention overrides for terminal sessions", () => {
      const session = createSession({
        status: "terminated",
        metadata: { attentionLevel: "working" },
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

    it("should ignore metadata attention overrides when merge criteria are met", () => {
      const session = createSession({
        status: "mergeable",
        metadata: { attentionLevel: "working" },
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

// Helper to create a minimal DashboardPR for testing
function createPR(overrides?: Partial<DashboardPR>): DashboardPR {
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
    ...overrides,
  };
}

describe("isPRMergeReady", () => {
  it("returns true for open PR with all criteria met", () => {
    const pr = createPR();
    expect(isPRMergeReady(pr)).toBe(true);
  });

  it("returns false for merged PR even with all criteria met", () => {
    const pr = createPR({ state: "merged" });
    expect(isPRMergeReady(pr)).toBe(false);
  });

  it("returns false for closed PR even with all criteria met", () => {
    const pr = createPR({ state: "closed" });
    expect(isPRMergeReady(pr)).toBe(false);
  });

  it("returns false for open PR that is not mergeable", () => {
    const pr = createPR({
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: ["Not mergeable"],
      },
    });
    expect(isPRMergeReady(pr)).toBe(false);
  });

  it("returns false for open PR with failing CI", () => {
    const pr = createPR({
      mergeability: {
        mergeable: true,
        ciPassing: false,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    expect(isPRMergeReady(pr)).toBe(false);
  });

  it("returns false for open PR that is not approved", () => {
    const pr = createPR({
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      },
    });
    expect(isPRMergeReady(pr)).toBe(false);
  });

  it("returns false for open PR with merge conflicts", () => {
    const pr = createPR({
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: false,
        blockers: [],
      },
    });
    expect(isPRMergeReady(pr)).toBe(false);
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
