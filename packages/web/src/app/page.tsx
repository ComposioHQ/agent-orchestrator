import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession } from "@/lib/types";
import { getServices, getSCM, getTracker } from "@/lib/services";
import { sessionToDashboard, enrichSessionPR, enrichSessionIssue, computeStats } from "@/lib/serialize";
import { prCache, prCacheKey } from "@/lib/cache";

export const dynamic = "force-dynamic";

export default async function Home() {
  let sessions: DashboardSession[] = [];
  try {
    const { config, registry, sessionManager } = await getServices();
    const coreSessions = await sessionManager.list();
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

      // Skip enrichment for terminal sessions
      if (terminalStatuses.has(core.status)) {
        return Promise.resolve();
      }

      // Skip enrichment if PR is already merged/closed (check cache)
      if (core.pr) {
        const cacheKey = prCacheKey(core.pr.owner, core.pr.repo, core.pr.number);
        const cached = prCache.get(cacheKey);
        if (cached && (cached.state === "merged" || cached.state === "closed")) {
          // Apply cached terminal state to session before skipping enrichment
          if (sessions[i].pr) {
            sessions[i].pr.state = cached.state;
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

  return <Dashboard sessions={sessions} stats={computeStats(sessions)} />;
}
