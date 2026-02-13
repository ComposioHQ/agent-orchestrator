/**
 * Dashboard-specific types for the web UI.
 * These extend/flatten the core types for client-side rendering.
 */

export type ActivityState = "active" | "idle" | "waiting_input" | "blocked" | "exited";

export type SessionStatus =
  | "spawning"
  | "working"
  | "pr_open"
  | "ci_failed"
  | "review_pending"
  | "changes_requested"
  | "approved"
  | "mergeable"
  | "merged"
  | "cleanup"
  | "needs_input"
  | "stuck"
  | "errored"
  | "killed";

export type CIStatus = "pending" | "passing" | "failing" | "none";

export type ReviewDecision = "approved" | "changes_requested" | "pending" | "none";

/** Attention zone priority level */
export type AttentionLevel = "urgent" | "action" | "warning" | "ok" | "done";

export interface DashboardSession {
  id: string;
  projectId: string;
  status: SessionStatus;
  activity: ActivityState;
  branch: string | null;
  issueId: string | null;
  summary: string | null;
  createdAt: string;
  lastActivityAt: string;
  pr: DashboardPR | null;
  metadata: Record<string, string>;
}

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

export interface DashboardCICheck {
  name: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  url?: string;
}

export interface DashboardMergeability {
  mergeable: boolean;
  ciPassing: boolean;
  approved: boolean;
  noConflicts: boolean;
  blockers: string[];
}

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

/** SSE event from /api/events */
export interface SSEEvent {
  type: string;
  sessionId: string;
  priority: "urgent" | "action" | "warning" | "info";
  message: string;
  data: Record<string, unknown>;
}

/** Determines which attention zone a session belongs to */
export function getAttentionLevel(session: DashboardSession): AttentionLevel {
  // Red zone: URGENT — needs human input
  if (session.activity === "waiting_input" || session.activity === "blocked") {
    return "urgent";
  }
  if (session.status === "needs_input" || session.status === "stuck" || session.status === "errored") {
    return "urgent";
  }

  // Check PR-related states
  if (session.pr) {
    const pr = session.pr;

    // Grey zone: done
    if (pr.state === "merged" || session.status === "merged") {
      return "done";
    }

    // Red zone: CI failed or changes requested with unresolved comments
    if (pr.ciStatus === "failing" || session.status === "ci_failed") {
      return "urgent";
    }
    if (pr.reviewDecision === "changes_requested" || !pr.mergeability.noConflicts) {
      return "urgent";
    }

    // Orange zone: ACTION — PRs ready to merge
    if (pr.mergeability.mergeable) {
      return "action";
    }

    // Yellow zone: WARNING — needs review, auto-fix failed
    if (pr.reviewDecision === "pending" || pr.unresolvedThreads > 0) {
      return "warning";
    }
  }

  // Grey zone: completed
  if (session.status === "killed" || session.activity === "exited") {
    return "done";
  }

  // Green zone: working normally
  return "ok";
}
