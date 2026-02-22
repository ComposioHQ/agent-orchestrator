/**
 * Core Session → DashboardSession serialization.
 *
 * Converts core types (Date objects, PRInfo) into dashboard types
 * (string dates, flattened DashboardPR) suitable for JSON serialization.
 */

import type {
  Session,
  Agent,
  SCM,
  PRInfo,
  Tracker,
  ProjectConfig,
  OrchestratorConfig,
  PluginRegistry,
} from "@composio/ao-core";
import type { DashboardSession, DashboardPR, DashboardStats } from "./types.js";
import { TTLCache, prCache, prCacheKey, type PREnrichmentData } from "./cache";

/** Cache for issue titles (5 min TTL — issue titles rarely change) */
const issueTitleCache = new TTLCache<string>(300_000);

/** Resolve which project a session belongs to. */
export function resolveProject(
  core: Session,
  projects: Record<string, ProjectConfig>,
): ProjectConfig | undefined {
  // Try explicit projectId first
  const direct = projects[core.projectId];
  if (direct) return direct;

  // Match by session prefix
  const entry = Object.entries(projects).find(([, p]) => core.id.startsWith(p.sessionPrefix));
  if (entry) return entry[1];

  // Fall back to first project
  const firstKey = Object.keys(projects)[0];
  return firstKey ? projects[firstKey] : undefined;
}

/** Convert a core Session to a DashboardSession (without PR/issue enrichment). */
export function sessionToDashboard(session: Session): DashboardSession {
  const agentSummary = session.agentInfo?.summary;
  const summary = agentSummary ?? session.metadata["summary"] ?? null;

  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId, // Deprecated: kept for backwards compatibility
    issueUrl: session.issueId, // issueId is actually the full URL
    issueLabel: null, // Will be enriched by enrichSessionIssue()
    issueTitle: null, // Will be enriched by enrichSessionIssueTitle()
    summary,
    summaryIsFallback: agentSummary
      ? (session.agentInfo?.summaryIsFallback ?? false)
      : false,
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
  opts?: { cacheOnly?: boolean },
): Promise<boolean> {
  if (!dashboard.pr) return false;

  const cacheKey = prCacheKey(pr.owner, pr.repo, pr.number);

  // Check cache first
  const cached = prCache.get(cacheKey);
  if (cached && dashboard.pr) {
    dashboard.pr.state = cached.state;
    dashboard.pr.title = cached.title;
    dashboard.pr.additions = cached.additions;
    dashboard.pr.deletions = cached.deletions;
    dashboard.pr.ciStatus = cached.ciStatus;
    dashboard.pr.ciChecks = cached.ciChecks;
    dashboard.pr.reviewDecision = cached.reviewDecision;
    dashboard.pr.mergeability = cached.mergeability;
    dashboard.pr.unresolvedThreads = cached.unresolvedThreads;
    dashboard.pr.unresolvedComments = cached.unresolvedComments;
    return true;
  }

  // Cache miss — if cacheOnly, signal caller to refresh in background
  if (opts?.cacheOnly) return false;

  // Fetch from SCM (with timing instrumentation)
  const enrichStart = Date.now();
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
  const enrichDurationMs = Date.now() - enrichStart;
  if (enrichDurationMs > 1000) {
    console.warn(
      `[enrichSessionPR] Slow enrichment for PR #${pr.number}: ${enrichDurationMs}ms`,
    );
  }

  const [summaryR, checksR, ciR, reviewR, mergeR, commentsR] = results;

  // Check if most critical requests failed (likely rate limit)
  // Note: Some methods (like getCISummary) return fallback values instead of rejecting,
  // so we can't rely on "all rejected" — check if majority failed instead
  const failedCount = results.filter((r) => r.status === "rejected").length;
  const mostFailed = failedCount >= results.length / 2;

  if (mostFailed) {
    const rejectedResults = results.filter(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult[];
    const firstError = rejectedResults[0]?.reason;
    console.warn(
      `[enrichSessionPR] ${failedCount}/${results.length} API calls failed for PR #${pr.number} (rate limited or unavailable):`,
      String(firstError),
    );
    // Don't return early — apply any successful results below
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
  if (
    mostFailed &&
    !dashboard.pr.mergeability.blockers.includes("API rate limited or unavailable")
  ) {
    dashboard.pr.mergeability.blockers.push("API rate limited or unavailable");
  }

  // If rate limited, cache the partial data with a long TTL (5 min) so we stop
  // hammering the API on every page load. The rate-limit blocker flag tells the
  // UI to show stale-data warnings instead of making decisions on bad data.
  if (mostFailed) {
    const rateLimitedData: PREnrichmentData = {
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
    prCache.set(cacheKey, rateLimitedData, 60 * 60_000); // 60 min — GitHub rate limit resets hourly
    return true;
  }

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
  return true;
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

/**
 * Enrich a DashboardSession's summary by calling agent.getSessionInfo().
 * Only fetches when the session doesn't already have a summary.
 * Reads the agent's JSONL file on disk — fast local I/O, not an API call.
 */
export async function enrichSessionAgentSummary(
  dashboard: DashboardSession,
  coreSession: Session,
  agent: Agent,
): Promise<void> {
  if (dashboard.summary) return;
  try {
    const info = await agent.getSessionInfo(coreSession);
    if (info?.summary) {
      dashboard.summary = info.summary;
      dashboard.summaryIsFallback = info.summaryIsFallback ?? false;
    }
  } catch {
    // Can't read agent session info — keep summary null
  }
}

/**
 * Enrich a DashboardSession's issue title by calling tracker.getIssue().
 * Extracts the identifier from the issue URL using issueLabel(),
 * then fetches full issue details for the title.
 */
export async function enrichSessionIssueTitle(
  dashboard: DashboardSession,
  tracker: Tracker,
  project: ProjectConfig,
): Promise<void> {
  if (!dashboard.issueUrl || !dashboard.issueLabel) return;

  // Check cache first
  const cached = issueTitleCache.get(dashboard.issueUrl);
  if (cached) {
    dashboard.issueTitle = cached;
    return;
  }

  try {
    // Strip "#" prefix from GitHub-style labels to get the identifier
    const identifier = dashboard.issueLabel.replace(/^#/, "");
    const issue = await tracker.getIssue(identifier, project);
    if (issue.title) {
      dashboard.issueTitle = issue.title;
      issueTitleCache.set(dashboard.issueUrl, issue.title);
    }
  } catch {
    // Can't fetch issue — keep issueTitle null
  }
}

/**
 * Enrich dashboard sessions with metadata (issue labels, agent summaries, issue titles).
 * Orchestrates sync + async enrichment in parallel. Does NOT enrich PR data — callers
 * handle that separately since strategies differ (e.g. terminal-session cache optimization).
 */
export async function enrichSessionsMetadata(
  coreSessions: Session[],
  dashboardSessions: DashboardSession[],
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<void> {
  // Resolve projects once per session (avoids repeated Object.entries lookups)
  const projects = coreSessions.map((core) => resolveProject(core, config.projects));

  // Enrich issue labels (synchronous — must run before async title enrichment)
  projects.forEach((project, i) => {
    if (!dashboardSessions[i].issueUrl || !project?.tracker) return;
    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker) return;
    enrichSessionIssue(dashboardSessions[i], tracker, project);
  });

  // Enrich agent summaries (reads agent's JSONL — local I/O, not an API call)
  const summaryPromises = coreSessions.map((core, i) => {
    if (dashboardSessions[i].summary) return Promise.resolve();
    const agentName = projects[i]?.agent ?? config.defaults.agent;
    if (!agentName) return Promise.resolve();
    const agent = registry.get<Agent>("agent", agentName);
    if (!agent) return Promise.resolve();
    return enrichSessionAgentSummary(dashboardSessions[i], core, agent);
  });

  // Enrich issue titles (fetches from tracker API, cached with TTL)
  const issueTitlePromises = projects.map((project, i) => {
    if (!dashboardSessions[i].issueUrl || !dashboardSessions[i].issueLabel) {
      return Promise.resolve();
    }
    if (!project?.tracker) return Promise.resolve();
    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker) return Promise.resolve();
    return enrichSessionIssueTitle(dashboardSessions[i], tracker, project);
  });

  await Promise.allSettled([...summaryPromises, ...issueTitlePromises]);
}

/** Compute dashboard stats from a list of sessions. */
export function computeStats(sessions: DashboardSession[]): DashboardStats {
  return {
    totalSessions: sessions.length,
    workingSessions: sessions.filter((s) => s.activity === "active").length,
    openPRs: sessions.filter((s) => s.pr?.state === "open").length,
    needsReview: sessions.filter((s) => s.pr && !s.pr.isDraft && s.pr.reviewDecision === "pending")
      .length,
  };
}
