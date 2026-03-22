import type { DashboardSession } from "@/lib/types";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
  listDashboardOrchestrators,
} from "@/lib/serialize";
import { prCache, prCacheKey } from "@/lib/cache";
import { filterProjectSessions, filterWorkerSessions } from "@/lib/project-utils";
import { resolveGlobalPause, type GlobalPauseState } from "@/lib/global-pause";

export interface DashboardPageData {
  sessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
  orchestrators: Array<{ id: string; projectId: string; projectName: string }>;
}

/**
 * Fetch and enrich dashboard data for a given project filter.
 * Pass `undefined` or `"all"` for the all-projects overview.
 */
export async function fetchDashboardData(projectFilter: string | undefined): Promise<DashboardPageData> {
  const pageData: DashboardPageData = {
    sessions: [],
    globalPause: null,
    orchestrators: [],
  };

  try {
    const { config, registry, sessionManager } = await getServices();
    const allSessions = await sessionManager.list();

    pageData.globalPause = resolveGlobalPause(allSessions);

    const filterKey = projectFilter ?? "all";
    const visibleSessions = filterProjectSessions(allSessions, filterKey, config.projects);

    pageData.orchestrators = listDashboardOrchestrators(visibleSessions, config.projects);

    const coreSessions = filterWorkerSessions(allSessions, filterKey, config.projects);
    pageData.sessions = coreSessions.map(sessionToDashboard);

    const metaTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([
      enrichSessionsMetadata(coreSessions, pageData.sessions, config, registry),
      metaTimeout,
    ]);

    const terminalStatuses = new Set(["merged", "killed", "cleanup", "done", "terminated"]);
    const enrichPromises = coreSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();

      const cacheKey = prCacheKey(core.pr.owner, core.pr.repo, core.pr.number);
      const cached = prCache.get(cacheKey);

      if (cached) {
        if (pageData.sessions[i].pr) {
          pageData.sessions[i].pr.state = cached.state;
          pageData.sessions[i].pr.title = cached.title;
          pageData.sessions[i].pr.additions = cached.additions;
          pageData.sessions[i].pr.deletions = cached.deletions;
          pageData.sessions[i].pr.ciStatus = cached.ciStatus as
            | "none"
            | "pending"
            | "passing"
            | "failing";
          pageData.sessions[i].pr.reviewDecision = cached.reviewDecision as
            | "none"
            | "pending"
            | "approved"
            | "changes_requested";
          pageData.sessions[i].pr.ciChecks = cached.ciChecks.map((c) => ({
            name: c.name,
            status: c.status as "pending" | "running" | "passed" | "failed" | "skipped",
            url: c.url,
          }));
          pageData.sessions[i].pr.mergeability = cached.mergeability;
          pageData.sessions[i].pr.unresolvedThreads = cached.unresolvedThreads;
          pageData.sessions[i].pr.unresolvedComments = cached.unresolvedComments;
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
      return enrichSessionPR(pageData.sessions[i], scm, core.pr);
    });
    const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    await Promise.race([Promise.allSettled(enrichPromises), enrichTimeout]);
  } catch {
    pageData.sessions = [];
    pageData.globalPause = null;
    pageData.orchestrators = [];
  }

  return pageData;
}
