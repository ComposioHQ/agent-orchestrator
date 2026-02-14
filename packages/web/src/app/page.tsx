import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession } from "@/lib/types";
import { getServices, getSCM } from "@/lib/services";
import { sessionToDashboard, enrichSessionPR, computeStats } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export default async function Home() {
  let sessions: DashboardSession[] = [];
  try {
    const { config, registry, sessionManager } = await getServices();
    const coreSessions = await sessionManager.list();
    sessions = coreSessions.map(sessionToDashboard);

    // Enrich sessions that have PRs with live SCM data
    const enrichPromises = coreSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();
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
