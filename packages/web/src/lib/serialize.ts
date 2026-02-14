/**
 * Core Session → DashboardSession serialization.
 *
 * Converts core types (Date objects, PRInfo) into dashboard types
 * (string dates, flattened DashboardPR) suitable for JSON serialization.
 */

import type { Session, SCM, PRInfo, Tracker, ProjectConfig } from "@agent-orchestrator/core";
import type { DashboardSession, DashboardPR, DashboardStats } from "./types.js";
import { prCache, prCacheKey, type PREnrichmentData } from "./cache";

/** Convert a core Session to a DashboardSession (without PR/issue enrichment). */
export function sessionToDashboard(session: Session): DashboardSession {
  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId, // Deprecated: kept for backwards compatibility
    issueUrl: session.issueId, // issueId is actually the full URL
    issueLabel: null, // Will be enriched by enrichSessionIssue()
    summary: session.agentInfo?.summary ?? session.metadata["summary"] ?? null,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    pr: session.pr ? basicPRToDashboard(session.pr) : null,
    metadata: session.metadata,
  };
}

/**
 * Convert minimal PRInfo to a DashboardPR with default values for enriched fields.
 * These defaults indicate "data not yet loaded" rather than "failing".
 * Use enrichSessionPR() to populate with live data from SCM.
 */
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
    ciStatus: "none", // "none" is neutral (no checks configured)
    ciChecks: [],
    reviewDecision: "none", // "none" is neutral (no review required)
    mergeability: {
      mergeable: false,
      ciPassing: false, // Conservative default
      approved: false,
      noConflicts: true, // Optimistic default (conflicts are rare)
      blockers: ["Data not loaded"], // Explicit blocker
    },
    unresolvedThreads: 0,
    unresolvedComments: [],
  };
}

/**
 * Enrich a DashboardSession's PR with live data from the SCM plugin.
 * Uses cache to reduce API calls and handles rate limit errors gracefully.
 */
export async function enrichSessionPR(
  dashboard: DashboardSession,
  scm: SCM,
  pr: PRInfo,
): Promise<void> {
  if (!dashboard.pr) return;

  const cacheKey = prCacheKey(pr.owner, pr.repo, pr.number);

  // Check cache first
  const cached = prCache.get(cacheKey);
  if (cached && dashboard.pr) {
    dashboard.pr.state = cached.state;
    dashboard.pr.title = cached.title;
    dashboard.pr.additions = cached.additions;
    dashboard.pr.deletions = cached.deletions;
    dashboard.pr.ciStatus = cached.ciStatus as "none" | "pending" | "passing" | "failing";
    dashboard.pr.ciChecks = cached.ciChecks as DashboardPR["ciChecks"];
    dashboard.pr.reviewDecision = cached.reviewDecision as
      | "none"
      | "pending"
      | "approved"
      | "changes_requested";
    dashboard.pr.mergeability = cached.mergeability;
    dashboard.pr.unresolvedThreads = cached.unresolvedThreads;
    dashboard.pr.unresolvedComments = cached.unresolvedComments;
    return;
  }

  // Fetch from SCM
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

  // Check if most critical requests failed (likely rate limit)
  // Note: Some methods (like getCISummary) return fallback values instead of rejecting,
  // so we can't rely on "all rejected" — check if majority failed instead
  const failedCount = results.filter((r) => r.status === "rejected").length;
  const mostFailed = failedCount >= results.length / 2;

  if (mostFailed) {
    // Log warning but continue to apply partial data
    const rejectedResults = results.filter(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult[];
    const firstError = rejectedResults[0]?.reason;
    console.error(
      `[enrichSessionPR] ${failedCount}/${results.length} API calls failed for PR #${pr.number}:`,
      firstError,
    );
    // Add blocker message but don't return early — apply any successful results below
  }

  // Apply successful results
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
  } else {
    // Mergeability failed — mark as unavailable
    dashboard.pr.mergeability.blockers = ["Merge status unavailable"];
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

  // Add rate-limit warning blocker if most requests failed
  // (but we still applied any successful results above)
  if (mostFailed && !dashboard.pr.mergeability.blockers.includes("API rate limited or unavailable")) {
    dashboard.pr.mergeability.blockers.push("API rate limited or unavailable");
  }

  // Always cache the result (including partial data from rate-limited requests)
  // This reduces API pressure during rate-limit periods - subsequent refreshes use cached partial data
  const cacheData: PREnrichmentData = {
    state: dashboard.pr.state,
    title: dashboard.pr.title,
    additions: dashboard.pr.additions,
    deletions: dashboard.pr.deletions,
    ciStatus: dashboard.pr.ciStatus,
    ciChecks: dashboard.pr.ciChecks,
    reviewDecision: dashboard.pr.reviewDecision,
    mergeability: dashboard.pr.mergeability,
    unresolvedThreads: dashboard.pr.unresolvedThreads,
    unresolvedComments: dashboard.pr.unresolvedComments,
  };
  prCache.set(cacheKey, cacheData);
}

/** Enrich a DashboardSession's issue label using the tracker plugin. */
export function enrichSessionIssue(
  dashboard: DashboardSession,
  tracker: Tracker,
  project: ProjectConfig,
): void {
  if (!dashboard.issueUrl) return;

  // Use tracker plugin to extract human-readable label from URL
  if (tracker.issueLabel) {
    try {
      dashboard.issueLabel = tracker.issueLabel(dashboard.issueUrl, project);
    } catch {
      // If extraction fails, fall back to extracting from URL manually
      const parts = dashboard.issueUrl.split("/");
      dashboard.issueLabel = parts[parts.length - 1] || dashboard.issueUrl;
    }
  } else {
    // Fallback if tracker doesn't implement issueLabel method
    const parts = dashboard.issueUrl.split("/");
    dashboard.issueLabel = parts[parts.length - 1] || dashboard.issueUrl;
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
