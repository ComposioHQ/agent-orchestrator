/**
 * Core Session → DashboardSession serialization.
 *
 * Converts core types (Date objects, PRInfo) into dashboard types
 * (string dates, flattened DashboardPR) suitable for JSON serialization.
 */

import type { Session, SCM, PRInfo } from "@agent-orchestrator/core";
import type { DashboardSession, DashboardPR, DashboardStats } from "./types.js";

/** Convert a core Session to a DashboardSession (without PR enrichment). */
export function sessionToDashboard(session: Session): DashboardSession {
  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId,
    summary: session.agentInfo?.summary ?? session.metadata["summary"] ?? null,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    pr: session.pr ? basicPRToDashboard(session.pr) : null,
    metadata: session.metadata,
  };
}

/** Convert minimal PRInfo to a DashboardPR with default values for enriched fields. */
function basicPRToDashboard(pr: PRInfo): DashboardPR {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    owner: pr.owner,
    repo: pr.repo,
    branch: pr.branch,
    baseBranch: pr.baseBranch,
    isDraft: pr.isDraft,
    state: "open",
    additions: 0,
    deletions: 0,
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
  };
}

/** Enrich a DashboardSession's PR with live data from the SCM plugin. */
export async function enrichSessionPR(
  dashboard: DashboardSession,
  scm: SCM,
  pr: PRInfo,
): Promise<void> {
  if (!dashboard.pr) return;

  const results = await Promise.allSettled([
    scm.getPRSummary
      ? scm.getPRSummary(pr)
      : scm.getPRState(pr).then((state) => ({ state, title: "", additions: 0, deletions: 0 })),
    scm.getCIChecks(pr),
    scm.getCISummary(pr),
    scm.getReviewDecision(pr),
    scm.getMergeability(pr),
    scm.getPendingComments(pr),
  ]);

  const [summaryR, checksR, ciR, reviewR, mergeR, commentsR] = results;

  if (summaryR.status === "fulfilled") {
    dashboard.pr.state = summaryR.value.state;
    dashboard.pr.additions = summaryR.value.additions;
    dashboard.pr.deletions = summaryR.value.deletions;
    if (summaryR.value.title) {
      dashboard.pr.title = summaryR.value.title;
    }
  }

  if (checksR.status === "fulfilled") {
    dashboard.pr.ciChecks = checksR.value.map((c) => ({
      name: c.name,
      status: c.status,
      url: c.url,
    }));
  }

  if (ciR.status === "fulfilled") {
    dashboard.pr.ciStatus = ciR.value;
  }

  if (reviewR.status === "fulfilled") {
    dashboard.pr.reviewDecision = reviewR.value;
  }

  if (mergeR.status === "fulfilled") {
    dashboard.pr.mergeability = mergeR.value;
  }

  if (commentsR.status === "fulfilled") {
    const comments = commentsR.value;
    dashboard.pr.unresolvedThreads = comments.length;
    dashboard.pr.unresolvedComments = comments.map((c) => ({
      url: c.url,
      path: c.path ?? "",
      author: c.author,
      body: c.body,
    }));
  }
}

/** Compute dashboard stats from a list of sessions. */
export function computeStats(sessions: DashboardSession[]): DashboardStats {
  return {
    totalSessions: sessions.length,
    workingSessions: sessions.filter((s) => s.activity === "active").length,
    openPRs: sessions.filter((s) => s.pr?.state === "open").length,
    needsReview: sessions.filter(
      (s) =>
        s.pr &&
        !s.pr.isDraft &&
        (s.pr.reviewDecision === "pending" || s.pr.reviewDecision === "none"),
    ).length,
  };
}
