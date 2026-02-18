import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession } from "@/lib/types";
import { getServices, getSCM, getTracker } from "@/lib/services";
import {
  sessionToDashboard,
  enrichSessionPR,
  enrichSessionIssue,
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

    // Enrich issue labels using tracker plugin (synchronous)
    coreSessions.forEach((core, i) => {
      if (!sessions[i].issueUrl) return;
      let project = config.projects[core.projectId];
      if (!project) {
        const entry = Object.entries(config.projects).find(([, p]) =>
          core.id.startsWith(p.sessionPrefix),
        );
        if (entry) project = entry[1];
      }
      if (!project) {
        const firstKey = Object.keys(config.projects)[0];
        if (firstKey) project = config.projects[firstKey];
      }
      const tracker = getTracker(registry, project);
      if (!tracker || !project) return;
      enrichSessionIssue(sessions[i], tracker, project);
    });

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

      let project = config.projects[core.projectId];
      if (!project) {
        const entry = Object.entries(config.projects).find(([, p]) =>
          core.id.startsWith(p.sessionPrefix),
        );
        if (entry) project = entry[1];
      }
      if (!project) {
        const firstKey = Object.keys(config.projects)[0];
        if (firstKey) project = config.projects[firstKey];
      }
      const scm = getSCM(registry, project);
      if (!scm) return Promise.resolve();
      return enrichSessionPR(sessions[i], scm, core.pr);
    });
    await Promise.allSettled(enrichPromises);
  } catch {
    // Config not found or services unavailable — show empty dashboard
  }

  return (
    <Dashboard sessions={sessions} stats={computeStats(sessions)} orchestratorId={orchestratorId} projectName={projectName} />
  );
}
