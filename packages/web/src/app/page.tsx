import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession } from "@/lib/types";
import { getServices, getSCM, getTracker } from "@/lib/services";
import { sessionToDashboard, enrichSessionPR, enrichSessionIssue, computeStats } from "@/lib/serialize";

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

      // Skip enrichment if PR is already merged/closed
      if (core.pr && sessions[i].pr) {
        const prState = sessions[i].pr?.state;
        if (prState === "merged" || prState === "closed") {
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
