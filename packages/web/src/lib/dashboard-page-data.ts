import "server-only";

import { cache } from "react";
import type { DashboardSession, DashboardOrchestratorLink } from "@/lib/types";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
  listDashboardOrchestrators,
} from "@/lib/serialize";
import { prCache, prCacheKey } from "@/lib/cache";
import { getPrimaryProjectId, getProjectName, getAllProjects, type ProjectInfo } from "@/lib/project-name";
import { filterProjectSessions, filterWorkerSessions } from "@/lib/project-utils";
import { resolveGlobalPause, type GlobalPauseState } from "@/lib/global-pause";

interface DashboardPageData {
  sessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
  orchestrators: DashboardOrchestratorLink[];
  projectName: string;
  projects: ProjectInfo[];
  selectedProjectId?: string;
}

export const getDashboardProjectName = cache(function getDashboardProjectName(
  projectFilter: string | undefined,
): string {
  if (projectFilter === "all") return "All Projects";
  const projects = getAllProjects();
  if (projectFilter) {
    const selectedProject = projects.find((project) => project.id === projectFilter);
    if (selectedProject) return selectedProject.name;
  }
  return getProjectName();
});

export function resolveDashboardProjectFilter(project?: string): string {
  if (project === "all") return "all";
  const projects = getAllProjects();
  if (project && projects.some((entry) => entry.id === project)) {
    return project;
  }
  return getPrimaryProjectId();
}

export const getDashboardPageData = cache(async function getDashboardPageData(project?: string): Promise<DashboardPageData> {
  const projectFilter = resolveDashboardProjectFilter(project);
  const pageData: DashboardPageData = {
    sessions: [],
    globalPause: null,
    orchestrators: [],
    projectName: getDashboardProjectName(projectFilter),
    projects: getAllProjects(),
    selectedProjectId: projectFilter === "all" ? undefined : projectFilter,
  };

  try {
    const { config, registry, sessionManager } = await getServices();
    const allSessions = await sessionManager.list();

    pageData.globalPause = resolveGlobalPause(allSessions);

    const visibleSessions = filterProjectSessions(allSessions, projectFilter, config.projects);
    pageData.orchestrators = listDashboardOrchestrators(visibleSessions, config.projects);

    const coreSessions = filterWorkerSessions(allSessions, projectFilter, config.projects);
    pageData.sessions = coreSessions.map(sessionToDashboard);

    const metaTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([
      enrichSessionsMetadata(coreSessions, pageData.sessions, config, registry),
      metaTimeout,
    ]);

    const terminalStatuses = new Set(["merged", "killed", "cleanup", "done", "terminated"]);
    const enrichPromises = coreSessions.map((core, index) => {
      if (!core.pr) return Promise.resolve();

      const cacheKey = prCacheKey(core.pr.owner, core.pr.repo, core.pr.number);
      const cached = prCache.get(cacheKey);

      if (cached) {
        const sessionPR = pageData.sessions[index]?.pr;
        if (sessionPR) {
          sessionPR.state = cached.state;
          sessionPR.title = cached.title;
          sessionPR.additions = cached.additions;
          sessionPR.deletions = cached.deletions;
          sessionPR.ciStatus = cached.ciStatus as
            | "none"
            | "pending"
            | "passing"
            | "failing";
          sessionPR.reviewDecision = cached.reviewDecision as
            | "none"
            | "pending"
            | "approved"
            | "changes_requested";
          sessionPR.ciChecks = cached.ciChecks.map((check) => ({
            name: check.name,
            status: check.status as "pending" | "running" | "passed" | "failed" | "skipped",
            url: check.url,
          }));
          sessionPR.mergeability = cached.mergeability;
          sessionPR.unresolvedThreads = cached.unresolvedThreads;
          sessionPR.unresolvedComments = cached.unresolvedComments;
        }

        if (
          terminalStatuses.has(core.status) ||
          cached.state === "merged" ||
          cached.state === "closed"
        ) {
          return Promise.resolve();
        }
      }

      const projectConfig = resolveProject(core, config.projects);
      const scm = getSCM(registry, projectConfig);
      if (!scm) return Promise.resolve();
      return enrichSessionPR(pageData.sessions[index], scm, core.pr);
    });
    const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    await Promise.race([Promise.allSettled(enrichPromises), enrichTimeout]);
  } catch {
    pageData.sessions = [];
    pageData.globalPause = null;
    pageData.orchestrators = [];
  }

  return pageData;
});
