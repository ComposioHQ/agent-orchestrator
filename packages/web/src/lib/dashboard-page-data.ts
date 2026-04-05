import { cache } from "react";
import type { DashboardSession, DashboardOrchestratorLink } from "@/lib/types";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadataFast,
  listDashboardOrchestrators,
} from "@/lib/serialize";
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

    pageData.globalPause = resolveGlobalPause(allSessions, config.projects);

    const visibleSessions = filterProjectSessions(allSessions, projectFilter, config.projects);
    pageData.orchestrators = listDashboardOrchestrators(visibleSessions, config.projects);

    const coreSessions = filterWorkerSessions(allSessions, projectFilter, config.projects);
    pageData.sessions = coreSessions.map(sessionToDashboard);

    // Fast enrichment: issue labels (sync) + agent summaries (local disk I/O)
    await enrichSessionsMetadataFast(coreSessions, pageData.sessions, config, registry);

    // PR cache hits only (in-memory lookup, no SCM API calls)
    const terminalStatuses = new Set(["merged", "killed", "cleanup", "done", "terminated"]);
    for (let i = 0; i < coreSessions.length; i++) {
      const core = coreSessions[i];
      if (!core.pr) continue;
      const projectConfig = resolveProject(core, config.projects);
      const scm = getSCM(registry, projectConfig);
      if (!scm) continue;
      await enrichSessionPR(pageData.sessions[i], scm, core.pr, { cacheOnly: true });

      // For terminal sessions with cache-miss PRs, infer state from session status
      // to avoid showing merged/closed PRs as "open" until client refresh
      const sessionPR = pageData.sessions[i].pr;
      if (sessionPR && !sessionPR.enriched && terminalStatuses.has(core.status)) {
        if (core.status === "merged") {
          sessionPR.state = "merged";
        }
      }
    }
  } catch {
    pageData.sessions = [];
    pageData.globalPause = null;
    pageData.orchestrators = [];
  }

  return pageData;
});
