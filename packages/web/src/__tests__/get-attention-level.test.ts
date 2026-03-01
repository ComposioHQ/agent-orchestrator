import { describe, it, expect } from "vitest";
import { getAttentionLevel } from "@/lib/types";
import { makeSession, makePR } from "./helpers";

describe("getAttentionLevel", () => {
  // ── MERGE (green zone — PRs ready to merge) ────────────────────────

  describe("merge zone", () => {
    it("returns merge when status is mergeable", () => {
      const pr = makePR({
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      });
      const session = makeSession({ status: "mergeable", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("merge");
    });

    it("returns merge when PR mergeability is true", () => {
      const pr = makePR({
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      });
      const session = makeSession({ status: "pr_open", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("merge");
    });
  });

  // ── RESPOND (red zone — agent needs human input) ───────────────────

  describe("respond zone", () => {
    it("returns respond when activity is waiting_input", () => {
      const session = makeSession({ activity: "waiting_input" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when activity is blocked", () => {
      const session = makeSession({ activity: "blocked" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is needs_input", () => {
      const session = makeSession({ status: "needs_input", activity: "idle" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is stuck", () => {
      const session = makeSession({ status: "stuck", activity: "idle" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is errored", () => {
      const session = makeSession({ status: "errored", activity: "idle" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when agent has exited unexpectedly (non-terminal status)", () => {
      const session = makeSession({ status: "working", activity: "exited", pr: null });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is errored even if activity is active", () => {
      const session = makeSession({ status: "errored", activity: "active" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is needs_input even if activity is active", () => {
      const session = makeSession({ status: "needs_input", activity: "active" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is stuck even if activity is active", () => {
      const session = makeSession({ status: "stuck", activity: "active" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("merge takes priority over respond (mergeable PR + blocked agent)", () => {
      const pr = makePR({
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      });
      const session = makeSession({ status: "mergeable", activity: "blocked", pr });
      expect(getAttentionLevel(session)).toBe("merge");
    });
  });

  // ── REVIEW (orange zone — needs investigation) ─────────────────────

  describe("review zone", () => {
    it("returns review when CI is failing", () => {
      const pr = makePR({
        ciStatus: "failing",
        ciChecks: [{ name: "test", status: "failed" }],
        reviewDecision: "approved",
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: ["CI failing"],
        },
      });
      const session = makeSession({ status: "ci_failed", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("returns review when changes are requested", () => {
      const pr = makePR({
        ciStatus: "passing",
        reviewDecision: "changes_requested",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: ["Changes requested"],
        },
      });
      const session = makeSession({ status: "changes_requested", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("returns review when there are merge conflicts", () => {
      const pr = makePR({
        ciStatus: "passing",
        reviewDecision: "approved",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: true,
          noConflicts: false,
          blockers: ["Merge conflict"],
        },
      });
      const session = makeSession({ status: "pr_open", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("review");
    });
  });

  // ── PENDING (yellow zone — waiting on external) ────────────────────

  describe("pending zone", () => {
    it("returns pending when review is pending", () => {
      const pr = makePR({
        reviewDecision: "pending",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: ["Needs review"],
        },
      });
      const session = makeSession({ status: "review_pending", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("returns pending when review decision is none", () => {
      const pr = makePR({
        reviewDecision: "none",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: ["Needs review"],
        },
      });
      const session = makeSession({ status: "pr_open", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("returns pending when there are unresolved threads", () => {
      const pr = makePR({
        reviewDecision: "approved",
        unresolvedThreads: 2,
        unresolvedComments: [
          { url: "https://example.com/1", path: "src/foo.ts", author: "bob", body: "fix this" },
          { url: "https://example.com/2", path: "src/bar.ts", author: "bob", body: "also this" },
        ],
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: ["Unresolved comments"],
        },
      });
      const session = makeSession({ status: "pr_open", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("pending");
    });
  });

  // ── WORKING (blue zone — agents doing their thing) ─────────────────

  describe("working zone", () => {
    it("returns working when actively working with no PR", () => {
      const session = makeSession({ status: "working", activity: "active", pr: null });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("returns working when spawning", () => {
      const session = makeSession({ status: "spawning", activity: "active", pr: null });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("returns working for idle session with no PR", () => {
      const session = makeSession({ status: "working", activity: "idle", pr: null });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("returns working for draft PR with reviewDecision none", () => {
      const pr = makePR({
        isDraft: true,
        reviewDecision: "none",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: ["Draft PR"],
        },
      });
      const session = makeSession({ status: "working", activity: "active", pr });
      expect(getAttentionLevel(session)).toBe("working");
    });
  });

  // ── DONE (grey zone — archived) ────────────────────────────────────

  describe("done zone", () => {
    it("returns done when PR is merged", () => {
      const pr = makePR({ state: "merged" });
      const session = makeSession({ status: "merged", activity: "exited", pr });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("returns done when PR is closed (not merged)", () => {
      const pr = makePR({ state: "closed" });
      const session = makeSession({ status: "working", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("returns done when session status is merged (even with open PR state)", () => {
      const pr = makePR({ state: "merged" });
      const session = makeSession({ status: "merged", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("returns done when session is killed", () => {
      const session = makeSession({ status: "killed", activity: "exited", pr: null });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("returns done when agent has exited with cleanup status", () => {
      const session = makeSession({ status: "cleanup", activity: "exited", pr: null });
      expect(getAttentionLevel(session)).toBe("done");
    });
  });
});
