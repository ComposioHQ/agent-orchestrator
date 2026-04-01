import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { homedir } from "node:os";
import { Dashboard } from "@/components/Dashboard";
import { DashboardShell } from "@/components/DashboardShell";
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
import { getAllProjects } from "@/lib/project-name";
import { filterProjectSessions, filterWorkerSessions } from "@/lib/project-utils";
import { resolveGlobalPause, type GlobalPauseState } from "@/lib/global-pause";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import { ensureProjectOrchestrator } from "@/lib/ensure-project-orchestrator";

export async function generateMetadata(props: {
  params: Promise<{ projectId: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  const projects = getAllProjects();
  const project = projects.find(p => p.id === params.projectId);
  const name = project?.name ?? params.projectId;
  return { title: { absolute: `ao | ${name}` } };
}

export default async function ProjectPage(props: {
  params: Promise<{ projectId: string }>;
}) {
  const params = await props.params;
  const projectFilter = params.projectId;

  const [{ projectSummaries }, pageData] = await Promise.all([
    loadPortfolioPageData(),
    loadProjectPageData(projectFilter),
  ]);

  const projects = getAllProjects();
  const project = projects.find(p => p.id === projectFilter);
  const projectName = project?.name ?? projectFilter;

  return (
    <DashboardShell
      projects={projectSummaries}
      activeProjectId={projectFilter}
      defaultLocation={homedir()}
    >
      <Dashboard
        initialSessions={pageData.sessions}
        projectId={projectFilter}
        projectName={projectName}
        projects={projects}
        initialGlobalPause={pageData.globalPause}
        orchestrators={pageData.orchestrators}
      />
    </DashboardShell>
  );
}

async function loadProjectPageData(projectFilter: string): Promise<{
  sessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
  orchestrators: Array<{ id: string; projectId: string; projectName: string }>;
}> {
  const pageData: {
    sessions: DashboardSession[];
    globalPause: GlobalPauseState | null;
    orchestrators: Array<{ id: string; projectId: string; projectName: string }>;
  } = {
    sessions: [],
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
    const coreSessions = filterWorkerSessions(allSessions, projectFilter, config.projects);
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
