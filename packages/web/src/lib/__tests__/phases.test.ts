import { describe, it, expect } from "vitest";
import {
  PHASE_LANES,
  DONE_PHASES,
  PHASE_LABELS,
  getPhaseLane,
  getPhaseStatusColor,
} from "@/lib/phases";
import type { SessionStatus } from "@/lib/types";

const ALL_STATUSES: readonly SessionStatus[] = [
  "spawning",
  "working",
  "pr_open",
  "ci_failed",
  "review_pending",
  "changes_requested",
  "approved",
  "mergeable",
  "merged",
  "cleanup",
  "needs_input",
  "stuck",
  "errored",
  "idle",
  "killed",
  "done",
  "terminated",
];

describe("getPhaseLane", () => {
  it("routes every SessionStatus to a lane or 'done'", () => {
    for (const status of ALL_STATUSES) {
      const lane = getPhaseLane(status);
      expect(lane).toBeDefined();
    }
  });

  it("routes terminal phases to 'done'", () => {
    for (const status of DONE_PHASES) {
      expect(getPhaseLane(status)).toBe("done");
    }
  });

  it.each([
    ["spawning", "prePr"],
    ["working", "prePr"],
    ["pr_open", "prReview"],
    ["ci_failed", "prReview"],
    ["review_pending", "prReview"],
    ["changes_requested", "prReview"],
    ["approved", "merge"],
    ["mergeable", "merge"],
    ["needs_input", "attention"],
    ["stuck", "attention"],
    ["errored", "attention"],
    ["idle", "attention"],
  ] as const)("%s → %s", (status, expected) => {
    expect(getPhaseLane(status)).toBe(expected);
  });

  it("every non-done status belongs to exactly one lane", () => {
    const active = ALL_STATUSES.filter((s) => !DONE_PHASES.includes(s));
    for (const status of active) {
      const hits = PHASE_LANES.filter((lane) => lane.statuses.includes(status));
      expect(hits.length).toBe(1);
    }
  });
});

describe("PHASE_LABELS", () => {
  it("has a human label for every SessionStatus", () => {
    for (const status of ALL_STATUSES) {
      expect(PHASE_LABELS[status]).toBeTruthy();
    }
  });
});

describe("getPhaseStatusColor", () => {
  it("returns a CSS var for known statuses", () => {
    expect(getPhaseStatusColor("working")).toMatch(/^var\(--color-/);
    expect(getPhaseStatusColor("ci_failed")).toMatch(/^var\(--color-/);
    expect(getPhaseStatusColor("merged")).toMatch(/^var\(--color-/);
  });

  it("falls back to text-secondary for unknown", () => {
    expect(getPhaseStatusColor("no_such_status")).toBe("var(--color-text-secondary)");
  });
});
