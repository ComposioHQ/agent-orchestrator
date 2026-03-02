/**
 * Mobile-local types mirroring the web dashboard types.
 * These must stay in sync with packages/web/src/lib/types.ts.
 */

export type SessionStatus =
  | "spawning"
  | "running"
  | "needs_input"
  | "stuck"
  | "errored"
  | "ci_failed"
  | "changes_requested"
  | "review_pending"
  | "mergeable"
  | "approved"
  | "merged"
  | "killed"
  | "cleanup"
  | "done"
  | "terminated";

export type ActivityState =
  | "starting"
  | "thinking"
  | "working"
  | "waiting_input"
  | "blocked"
  | "idle"
  | "exited";

export type CIStatus = "none" | "pending" | "passing" | "failing";
export type ReviewDecision = "none" | "pending" | "approved" | "changes_requested";

export type AttentionLevel = "merge" | "respond" | "review" | "pending" | "working" | "done";

export interface DashboardCICheck {
  name: string;
  status: string;
  url?: string;
}

export interface DashboardMergeability {
  mergeable: boolean;
  ciPassing: boolean;
  approved: boolean;
  noConflicts: boolean;
  blockers: string[];
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
}

export interface DashboardSession {
  id: string;
  projectId: string;
  status: SessionStatus;
  activity: ActivityState | null;
  branch: string | null;
  issueId: string | null;
  issueUrl: string | null;
  issueLabel: string | null;
  issueTitle: string | null;
  summary: string | null;
  summaryIsFallback: boolean;
  createdAt: string;
  lastActivityAt: string;
  pr: DashboardPR | null;
  metadata: Record<string, string>;
}

export interface DashboardStats {
  totalSessions: number;
  workingSessions: number;
  openPRs: number;
  needsReview: number;
}

export interface SessionsResponse {
  sessions: DashboardSession[];
  stats: DashboardStats;
}

/** Attention level colors matching the web dashboard */
export const ATTENTION_COLORS: Record<AttentionLevel, string> = {
  merge: "#3fb950",
  respond: "#f85149",
  review: "#d29922",
  pending: "#e3b341",
  working: "#58a6ff",
  done: "#8b949e",
};

/** Terminal states that cannot be restored */
const TERMINAL_STATUSES: SessionStatus[] = ["merged", "killed", "cleanup", "done", "terminated"];
const TERMINAL_ACTIVITIES: ActivityState[] = ["exited"];
const NON_RESTORABLE_STATUSES: SessionStatus[] = ["merged", "done", "terminated"];

export function isTerminal(session: DashboardSession): boolean {
  return (
    TERMINAL_STATUSES.includes(session.status) ||
    TERMINAL_ACTIVITIES.includes(session.activity as ActivityState)
  );
}

export function isRestorable(session: DashboardSession): boolean {
  return (
    session.activity === "exited" &&
    !NON_RESTORABLE_STATUSES.includes(session.status)
  );
}

function isPRRateLimited(pr: DashboardPR): boolean {
  return pr.mergeability.blockers.includes("API rate limited or unavailable");
}

/** Determines which attention zone a session belongs to */
export function getAttentionLevel(session: DashboardSession): AttentionLevel {
  // Done: terminal states
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

  // Merge: PR is ready
  if (session.status === "mergeable" || session.status === "approved") {
    return "merge";
  }
  if (session.pr?.mergeability.mergeable) {
    return "merge";
  }

  // Respond: agent waiting for human input
  if (session.activity === "waiting_input" || session.activity === "blocked") {
    return "respond";
  }
  if (
    session.status === "needs_input" ||
    session.status === "stuck" ||
    session.status === "errored"
  ) {
    return "respond";
  }
  if (session.activity === "exited") {
    return "respond";
  }

  // Review: problems that need investigation
  if (session.status === "ci_failed" || session.status === "changes_requested") {
    return "review";
  }
  if (session.pr && !isPRRateLimited(session.pr)) {
    const pr = session.pr;
    if (pr.ciStatus === "failing") return "review";
    if (pr.reviewDecision === "changes_requested") return "review";
    if (!pr.mergeability.noConflicts) return "review";
  }

  // Pending: waiting on external
  if (session.status === "review_pending") {
    return "pending";
  }
  if (session.pr && !isPRRateLimited(session.pr)) {
    const pr = session.pr;
    if (!pr.isDraft && pr.unresolvedThreads > 0) return "pending";
    if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
      return "pending";
    }
  }

  // Working: agents doing their thing
  return "working";
}

/** Human-readable relative time */
export function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}
