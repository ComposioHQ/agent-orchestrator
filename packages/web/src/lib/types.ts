/**
 * Dashboard-specific types for the web UI.
 *
 * Core types (SessionStatus, ActivityState, CIStatus, ReviewDecision, etc.)
 * are re-exported from @composio/ao-core. Dashboard-specific types
 * extend/flatten the core types for client-side rendering (e.g. DashboardPR
 * flattens core PRInfo + MergeReadiness + CICheck[] + ReviewComment[]).
 */

// Re-export core types used directly by the dashboard
export type {
  SessionStatus,
  ActivityState,
  CIStatus,
  ReviewDecision,
  MergeReadiness,
  PRState,
} from "@composio/ao-core/types";

import {
  ACTIVITY_STATE,
  type CICheck as CoreCICheck,
  type MergeReadiness,
  type CIStatus,
  type SessionStatus,
  type ActivityState,
  type ReviewDecision,
} from "@composio/ao-core/types";

/**
 * Attention zone priority level, ordered by human action urgency:
 *
 * 1. merge   — PR approved + CI green. One click to clear. Highest ROI.
 * 2. respond — Agent waiting for human input. Quick unblock, agent resumes.
 * 3. review  — CI failed, changes requested, conflicts. Needs investigation.
 * 4. pending — Waiting on external (reviewer, CI). Nothing to do right now.
 * 5. working — Agents doing their thing. Don't interrupt.
 * 6. done    — Merged or terminated. Archive.
 */
export type AttentionLevel = "merge" | "respond" | "review" | "pending" | "working" | "done";

/**
 * Flattened session for dashboard rendering.
 * Maps to core Session but uses string dates (JSON-serializable for SSR/client boundary)
 * and inlines PR state.
 *
 * TODO: When wiring to real data, add a serialization layer that converts
 * core Session (Date objects) → DashboardSession (string dates).
 */
export interface DashboardSession {
  id: string;
  projectId: string;
  status: SessionStatus;
  activity: ActivityState;
  branch: string | null;
  issueId: string | null; // Deprecated: use issueUrl instead
  issueUrl: string | null; // Full issue URL
  issueLabel: string | null; // Human-readable label (e.g., "INT-1327", "#42")
  summary: string | null;
  createdAt: string;
  lastActivityAt: string;
  pr: DashboardPR | null;
  metadata: Record<string, string>;
}

/**
 * Flattened PR for dashboard rendering.
 * Aggregates core PRInfo + PRState + CICheck[] + MergeReadiness + ReviewComment[].
 */
export interface DashboardPR {
  number: number;
  url: string;
  title: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  isDraft: boolean;
  state: "open" | "merged" | "closed";
  additions: number;
  deletions: number;
  ciStatus: CIStatus;
  ciChecks: DashboardCICheck[];
  reviewDecision: ReviewDecision;
  mergeability: DashboardMergeability;
  unresolvedThreads: number;
  unresolvedComments: DashboardUnresolvedComment[];
}

/**
 * Mirrors core CICheck but omits Date fields (not JSON-serializable).
 * Core CICheck also has conclusion, startedAt, completedAt.
 */
export interface DashboardCICheck {
  name: string;
  status: CoreCICheck["status"];
  url?: string;
}

/**
 * Same shape as core MergeReadiness — re-exported for convenience.
 */
export type DashboardMergeability = MergeReadiness;

export interface DashboardUnresolvedComment {
  url: string;
  path: string;
  author: string;
  body: string;
}

export interface DashboardStats {
  totalSessions: number;
  workingSessions: number;
  openPRs: number;
  needsReview: number;
}

/** SSE snapshot event from /api/events */
export interface SSESnapshotEvent {
  type: "snapshot";
  sessions: Array<{
    id: string;
    status: SessionStatus;
    activity: ActivityState;
    attentionLevel: AttentionLevel;
    lastActivityAt: string;
  }>;
}

/** SSE activity update event from /api/events */
export interface SSEActivityEvent {
  type: "session.activity";
  sessionId: string;
  activity: ActivityState;
  status: SessionStatus;
  attentionLevel: AttentionLevel;
  timestamp: string;
}

/** Determines which attention zone a session belongs to */
export function getAttentionLevel(session: DashboardSession): AttentionLevel {
  // ── Done: terminal states ─────────────────────────────────────────
  if (
    session.status === "merged" ||
    session.status === "killed" ||
    session.status === "cleanup" ||
    session.status === "done" ||
    session.status === "terminated"
  ) {
    return "done";
  }
  if (session.pr) {
    if (session.pr.state === "merged" || session.pr.state === "closed") {
      return "done";
    }
  }

  // ── Merge: PR is ready — one click to clear ───────────────────────
  // Check this early: if the PR is mergeable, that's the most valuable
  // action for the human regardless of agent activity.
  if (session.status === "mergeable" || session.status === "approved") {
    return "merge";
  }
  if (session.pr?.mergeability.mergeable) {
    return "merge";
  }

  // ── Respond: agent is waiting for human input ─────────────────────
  if (session.activity === ACTIVITY_STATE.WAITING_INPUT || session.activity === ACTIVITY_STATE.BLOCKED) {
    return "respond";
  }
  if (
    session.status === "needs_input" ||
    session.status === "stuck" ||
    session.status === "errored"
  ) {
    return "respond";
  }
  // Exited agent with non-terminal status = crashed, needs human attention
  if (session.activity === ACTIVITY_STATE.EXITED) {
    return "respond";
  }

  // ── Review: problems that need investigation ──────────────────────
  if (session.status === "ci_failed" || session.status === "changes_requested") {
    return "review";
  }
  if (session.pr) {
    const pr = session.pr;
    if (pr.ciStatus === "failing") return "review";
    if (pr.reviewDecision === "changes_requested") return "review";
    if (!pr.mergeability.noConflicts) return "review";
  }

  // ── Pending: waiting on external (reviewer, CI) ───────────────────
  if (session.status === "review_pending") {
    return "pending";
  }
  if (session.pr) {
    const pr = session.pr;
    if (!pr.isDraft && pr.unresolvedThreads > 0) return "pending";
    if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
      return "pending";
    }
  }

  // ── Working: agents doing their thing ─────────────────────────────
  return "working";
}
