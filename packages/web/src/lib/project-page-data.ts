import { isOrchestratorSession } from "@composio/ao-core";
import type { DashboardSession, GlobalPauseState } from "@/lib/types";
import { getServices, getSCM } from "@/lib/services";
import {
  enrichSessionPR,
  enrichSessionsMetadata,
  listDashboardOrchestrators,
  resolveProject,
  sessionToDashboard,
} from "@/lib/serialize";
import { prCache, prCacheKey } from "@/lib/cache";
import { filterProjectSessions } from "@/lib/project-utils";
import { resolveGlobalPause } from "@/lib/global-pause";
import { ensureProjectOrchestrator } from "@/lib/ensure-project-orchestrator";

export interface ProjectPageData {
  sessions: DashboardSession[];
  sidebarSessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
  orchestrators: Array<{ id: string; projectId: string; projectName: string }>;
}

export async function loadProjectPageData(projectFilter: string): Promise<ProjectPageData> {
  const pageData: ProjectPageData = {
    sessions: [],
    sidebarSessions: [],
    globalPause: null,
    orchestrators: [],
  };

  try {
    try {
      await ensureProjectOrchestrator(projectFilter);
    } catch {
      // Best-effort self-heal: if orchestrator startup fails, continue to render
      // the page using whatever sessions currently exist.
    }

    const { config, registry, sessionManager } = await getServices();
    const allSessions = await sessionManager.list();

    pageData.globalPause = resolveGlobalPause(allSessions);
    const visibleSessions = filterProjectSessions(allSessions, projectFilter, config.projects);
    pageData.orchestrators = listDashboardOrchestrators(visibleSessions, config.projects);
    pageData.sidebarSessions = visibleSessions.map(sessionToDashboard);

    const metaTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([
      enrichSessionsMetadata(visibleSessions, pageData.sidebarSessions, config, registry),
      metaTimeout,
    ]);

    const workerSessions: DashboardSession[] = [];
    const workerEntries = visibleSessions
      .map((core, index) => ({ core, dashboard: pageData.sidebarSessions[index] }))
      .filter((entry) => !isOrchestratorSession(entry.core));
    for (const entry of workerEntries) {
      workerSessions.push(entry.dashboard);
    }
    pageData.sessions = workerSessions;

    const terminalStatuses = new Set(["merged", "killed", "cleanup", "done", "terminated"]);
    const enrichPromises = workerEntries.map(({ core, dashboard }) => {
      if (!core.pr) return Promise.resolve();
      const cacheKey = prCacheKey(core.pr.owner, core.pr.repo, core.pr.number);
      const cached = prCache.get(cacheKey);

      if (cached) {
        if (dashboard.pr) {
          dashboard.pr.state = cached.state;
          dashboard.pr.title = cached.title;
          dashboard.pr.additions = cached.additions;
          dashboard.pr.deletions = cached.deletions;
          dashboard.pr.ciStatus = cached.ciStatus as
            | "none"
            | "pending"
            | "passing"
            | "failing";
          dashboard.pr.reviewDecision = cached.reviewDecision as
            | "none"
            | "pending"
            | "approved"
            | "changes_requested";
          dashboard.pr.ciChecks = cached.ciChecks.map((c) => ({
            name: c.name,
            status: c.status as "pending" | "running" | "passed" | "failed" | "skipped",
            url: c.url,
          }));
          dashboard.pr.mergeability = cached.mergeability;
          dashboard.pr.unresolvedThreads = cached.unresolvedThreads;
          dashboard.pr.unresolvedComments = cached.unresolvedComments;
        }
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
      return enrichSessionPR(dashboard, scm, core.pr);
    });
    const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    await Promise.race([Promise.allSettled(enrichPromises), enrichTimeout]);
  } catch {
    pageData.sessions = [];
    pageData.sidebarSessions = [];
    pageData.globalPause = null;
    pageData.orchestrators = [];
  }

  return pageData;
}
