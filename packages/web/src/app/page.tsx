import type { Metadata } from "next";
import type { Tracker } from "@composio/ao-core";
import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession } from "@/lib/types";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionIssue,
  enrichSessionsMetadata,
  computeStats,
} from "@/lib/serialize";
import { prCache, prCacheKey } from "@/lib/cache";
import { getProjectName } from "@/lib/project-name";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const projectName = getProjectName();
  // Use absolute to opt out of the layout's "%s | project" template
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function Home() {
  let sessions: DashboardSession[] = [];
  let stats = computeStats([]);
  let orchestratorId: string | null = null;
  const projectName = getProjectName();
  try {
    const { config, registry, sessionManager } = await getServices();
    const allSessions = await sessionManager.list();

    // Find the orchestrator session (any session ending with -orchestrator)
    // Only set orchestratorId if an actual session exists (no fallback)
    const orchSession = allSessions.find((s) => s.id.endsWith("-orchestrator"));
    if (orchSession) {
      orchestratorId = orchSession.id;
    }

    // Filter out orchestrator from worker sessions
    const coreSessions = allSessions.filter((s) => !s.id.endsWith("-orchestrator"));
    sessions = coreSessions.map(sessionToDashboard);

    // Enrich metadata (issue labels, agent summaries, issue titles) — cap at 3s
    const metaTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([enrichSessionsMetadata(coreSessions, sessions, config, registry), metaTimeout]);

    // Enrich sessions that have PRs with live SCM data
    // Skip enrichment for terminal sessions (merged, closed, done, terminated)
    const terminalStatuses = new Set(["merged", "killed", "cleanup", "done", "terminated"]);
    const enrichPromises = coreSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();

      // Check cache first (before terminal status check)
      const cacheKey = prCacheKey(core.pr.owner, core.pr.repo, core.pr.number);
      const cached = prCache.get(cacheKey);

      // Apply cached data if available (for both terminal and non-terminal sessions)
      if (cached) {
        if (sessions[i].pr) {
          // Apply ALL cached fields (not just some)
          sessions[i].pr.state = cached.state;
          sessions[i].pr.title = cached.title;
          sessions[i].pr.additions = cached.additions;
          sessions[i].pr.deletions = cached.deletions;
          sessions[i].pr.ciStatus = cached.ciStatus as "none" | "pending" | "passing" | "failing";
          sessions[i].pr.reviewDecision = cached.reviewDecision as
            | "none"
            | "pending"
            | "approved"
            | "changes_requested";
          sessions[i].pr.ciChecks = cached.ciChecks.map((c) => ({
            name: c.name,
            status: c.status as "pending" | "running" | "passed" | "failed" | "skipped",
            url: c.url,
          }));
          sessions[i].pr.mergeability = cached.mergeability;
          sessions[i].pr.unresolvedThreads = cached.unresolvedThreads;
          sessions[i].pr.unresolvedComments = cached.unresolvedComments;
        }

        // Skip enrichment if cache is fresh AND (terminal OR merged/closed)
        // This allows terminal sessions to be enriched once when cache is missing/expired
        if (
          terminalStatuses.has(core.status) ||
          cached.state === "merged" ||
          cached.state === "closed"
        ) {
          return Promise.resolve();
        }
      }

      const project = resolveProject(core, config.projects);
      const scm = getSCM(registry, project);
      if (!scm) return Promise.resolve();
      return enrichSessionPR(sessions[i], scm, core.pr);
    });
    // Cap enrichment at 4s — if GitHub is slow/rate-limited, serve stale data fast
    const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    await Promise.race([Promise.allSettled(enrichPromises), enrichTimeout]);

    // Compute stats from active sessions only (before appending archived)
    stats = computeStats(sessions);

    // Append archived sessions (killed/cleaned up) — no expensive enrichment
    const archivedSessions = await sessionManager.listArchived();
    const activeIds = new Set(sessions.map((s) => s.id));
    const archivedWorkers = archivedSessions.filter(
      (s) => !s.id.endsWith("-orchestrator") && !activeIds.has(s.id),
    );
    const archivedDashboard = archivedWorkers.map(sessionToDashboard);

    // Cheap issue label enrichment only (sync, no API calls)
    for (const ds of archivedDashboard) {
      if (!ds.issueUrl) continue;
      const project = Object.values(config.projects).find((p) =>
        ds.id.startsWith(p.sessionPrefix),
      );
      if (!project?.tracker) continue;
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (!tracker) continue;
      enrichSessionIssue(ds, tracker, project);
    }

    sessions.push(...archivedDashboard);
  } catch {
    // Config not found or services unavailable — show empty dashboard
  }

  return (
    <Dashboard initialSessions={sessions} stats={stats} orchestratorId={orchestratorId} projectName={projectName} />
  );
}
