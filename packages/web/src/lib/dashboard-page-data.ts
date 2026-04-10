import "server-only";

import { cache } from "react";
import { TERMINAL_STATUSES, type DashboardSession, type DashboardOrchestratorLink } from "@/lib/types";
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
import { settlesWithin } from "@/lib/async-utils";

const FAST_METADATA_ENRICH_TIMEOUT_MS = 3_000;


interface DashboardPageData {
  sessions: DashboardSession[];
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
    orchestrators: [],
    projectName: getDashboardProjectName(projectFilter),
    projects: getAllProjects(),
    selectedProjectId: projectFilter === "all" ? undefined : projectFilter,
  };

  try {
    const { config, registry, sessionManager } = await getServices();
    const allSessions = await sessionManager.list();

    const visibleSessions = filterProjectSessions(allSessions, projectFilter, config.projects);
    pageData.orchestrators = listDashboardOrchestrators(visibleSessions, config.projects);

    const coreSessions = filterWorkerSessions(allSessions, projectFilter, config.projects);
    pageData.sessions = coreSessions.map(sessionToDashboard);

    // Fast enrichment: issue labels (sync) + agent summaries (local disk I/O).
    // Keep a hard cap here so a slow local agent plugin can't stall SSR indefinitely.
    await settlesWithin(
      enrichSessionsMetadataFast(coreSessions, pageData.sessions, config, registry),
      FAST_METADATA_ENRICH_TIMEOUT_MS,
    );

    // PR cache hits only (in-memory lookup, no SCM API calls)
    // TERMINAL_STATUSES includes merged, killed, cleanup, done, terminated, errored
    for (let i = 0; i < coreSessions.length; i++) {
      const core = coreSessions[i];
      if (!core.pr) continue;
      const projectConfig = resolveProject(core, config.projects);
      const scm = getSCM(registry, projectConfig);
      if (scm) {
        await enrichSessionPR(pageData.sessions[i], scm, core.pr, { cacheOnly: true });
      }

      // For cache-miss PRs, infer terminal PR state from lifecycle status
      // to avoid showing merged/closed PRs as "open" until client refresh.
      const sessionPR = pageData.sessions[i].pr;
      if (sessionPR && !sessionPR.enriched && TERMINAL_STATUSES.has(core.status)) {
        if (core.status === "merged") {
          sessionPR.state = "merged";
        } else if (core.status === "killed") {
          sessionPR.state = "closed";
        }
      }
    }
  } catch {
    pageData.sessions = [];
    pageData.orchestrators = [];
  }

  return pageData;
});
