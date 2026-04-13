import type { SessionStatus } from "@/lib/types";

export type PhaseLaneId = "prePr" | "prReview" | "merge" | "attention";

export interface PhaseLaneDef {
  id: PhaseLaneId;
  label: string;
  description: string;
  statuses: readonly SessionStatus[];
}

export const PHASE_LANES: readonly PhaseLaneDef[] = [
  {
    id: "prePr",
    label: "Pre-PR",
    description: "Agent is working, no PR yet",
    statuses: ["spawning", "working"],
  },
  {
    id: "prReview",
    label: "PR Review",
    description: "PR open, CI and review in flight",
    statuses: ["pr_open", "ci_failed", "review_pending", "changes_requested"],
  },
  {
    id: "merge",
    label: "Merge",
    description: "Approved and ready to land",
    statuses: ["approved", "mergeable"],
  },
  {
    id: "attention",
    label: "Attention",
    description: "Stuck, errored, or waiting on human",
    statuses: ["needs_input", "stuck", "errored", "idle"],
  },
] as const;

export const DONE_PHASES: readonly SessionStatus[] = [
  "merged",
  "cleanup",
  "done",
  "killed",
  "terminated",
] as const;

export const PHASE_LABELS: Record<SessionStatus, string> = {
  spawning: "Spawning",
  working: "Working",
  pr_open: "PR Open",
  ci_failed: "CI Failed",
  review_pending: "Review Pending",
  changes_requested: "Changes Requested",
  approved: "Approved",
  mergeable: "Mergeable",
  needs_input: "Needs Input",
  stuck: "Stuck",
  errored: "Errored",
  idle: "Idle",
  merged: "Merged",
  cleanup: "Cleanup",
  done: "Done",
  killed: "Killed",
  terminated: "Terminated",
};

/** Maps a SessionStatus to one of our lanes, or "done" for terminal statuses. */
export function getPhaseLane(status: SessionStatus): PhaseLaneId | "done" {
  if (DONE_PHASES.includes(status)) return "done";
  for (const lane of PHASE_LANES) {
    if (lane.statuses.includes(status)) return lane.id;
  }
  return "attention";
}

/** CSS var reference for the dot color of a given lifecycle phase. */
export function getPhaseStatusColor(status: string): string {
  switch (status) {
    case "working":
      return "var(--color-status-working)";
    case "spawning":
      return "var(--color-status-attention)";
    case "pr_open":
    case "review_pending":
    case "approved":
    case "mergeable":
      return "var(--color-status-ready)";
    case "ci_failed":
    case "changes_requested":
      return "var(--color-status-error)";
    case "needs_input":
    case "stuck":
    case "errored":
      return "var(--color-status-respond)";
    case "idle":
      return "var(--color-status-idle)";
    case "merged":
    case "done":
    case "cleanup":
    case "killed":
    case "terminated":
      return "var(--color-text-tertiary)";
    default:
      return "var(--color-text-secondary)";
  }
}
