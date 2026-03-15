import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePR, makeSession } from "@/__tests__/helpers";
import {
  getPRBlockers,
  getPRStatusBadges,
  getSessionInspectionChips,
  getSessionMetaSummary,
  getSessionTrustBadges,
} from "../session-inspection";

describe("session inspection helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T20:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports merge-ready state explicitly", () => {
    const pr = makePR();

    expect(getPRStatusBadges(pr)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "review", label: "approved", tone: "success" }),
        expect.objectContaining({ key: "merge-ready", label: "merge ready", tone: "success" }),
      ]),
    );
    expect(getPRBlockers(pr)).toEqual([]);
  });

  it("surfaces rate-limited PRs without pretending CI or review data is authoritative", () => {
    const pr = makePR({
      ciStatus: "none",
      reviewDecision: "pending",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: false,
        blockers: ["API rate limited or unavailable"],
      },
    });

    expect(getPRStatusBadges(pr)).toEqual([
      expect.objectContaining({ key: "rate-limited", tone: "warning" }),
    ]);
    expect(getPRBlockers(pr)).toEqual([
      expect.objectContaining({
        text: "GitHub details unavailable due to rate limiting",
      }),
    ]);
  });

  it("summarizes blockers for CI, review, conflicts, and unresolved threads", () => {
    const pr = makePR({
      ciStatus: "failing",
      ciChecks: [
        { name: "build", status: "failed" },
        { name: "test", status: "failed" },
      ],
      reviewDecision: "changes_requested",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: false,
        blockers: ["CI failing", "Changes requested"],
      },
      unresolvedThreads: 2,
    });

    expect(getPRBlockers(pr).map((blocker) => blocker.text)).toEqual([
      "CI failing - 2 checks failed",
      "Changes requested",
      "Merge conflicts",
      "2 unresolved comments",
    ]);
  });

  it("formats session metadata and inspection chips from shared dashboard fields", () => {
    const session = makeSession({
      createdAt: "2026-03-14T18:30:00Z",
      lastActivityAt: "2026-03-14T19:55:00Z",
      projectId: "alpha",
      pr: makePR({ number: 42 }),
    });

    expect(getSessionMetaSummary(session)).toEqual(["Working", "created 1h ago", "active 5m ago"]);
    expect(getSessionInspectionChips(session)).toEqual([
      expect.objectContaining({ key: "project", label: "alpha" }),
      expect.objectContaining({ key: "pr", label: "PR #42" }),
      expect.objectContaining({ key: "branch", label: "feat/test", mono: true }),
      expect.objectContaining({ key: "issue", label: "INT-100" }),
    ]);
  });

  it("adds persistent trust badges for paused, limited, and drifting session details", () => {
    const session = makeSession({
      pr: makePR({
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: false,
          blockers: ["API rate limited or unavailable"],
        },
      }),
    });

    expect(
      getSessionTrustBadges(session, {
        alignment: {
          affectedLevels: ["review"],
          currentCounts: { merge: 0, respond: 0, review: 0, pending: 0, working: 1, done: 0 },
          expectedCounts: { merge: 0, respond: 0, review: 1, pending: 0, working: 0, done: 0 },
          expectedMembershipCount: 1,
          status: "drifted",
        },
        paused: true,
      }),
    ).toEqual([
      expect.objectContaining({ key: "paused", tone: "danger" }),
      expect.objectContaining({ key: "limited", tone: "warning" }),
      expect.objectContaining({ key: "drifted", tone: "warning" }),
    ]);
  });
});
