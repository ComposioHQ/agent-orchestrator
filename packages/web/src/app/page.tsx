import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession, DispatchPlanItem, HarnessSnapshot } from "@/lib/types";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
  listDashboardOrchestrators,
} from "@/lib/serialize";
import { prCache, prCacheKey } from "@/lib/cache";
import { getPrimaryProjectId, getProjectName, getAllProjects } from "@/lib/project-name";
import { filterProjectSessions, filterWorkerSessions } from "@/lib/project-utils";
import { resolveGlobalPause, type GlobalPauseState } from "@/lib/global-pause";
import { loadHarnessSnapshot } from "@/lib/harness-plan";

function getSelectedProjectName(projectFilter: string | undefined): string {
  if (projectFilter === "all") return "All Projects";
  const projects = getAllProjects();
  if (projectFilter) {
    const selectedProject = projects.find((project) => project.id === projectFilter);
    if (selectedProject) return selectedProject.name;
  }
  return getProjectName();
}

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectFilter = searchParams.project ?? getPrimaryProjectId();
  const projectName = getSelectedProjectName(projectFilter);
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function Home(props: { searchParams: Promise<{ project?: string }> }) {
  const searchParams = await props.searchParams;
  const projectFilter = searchParams.project ?? getPrimaryProjectId();
  const pageData: {
    sessions: DashboardSession[];
    globalPause: GlobalPauseState | null;
    orchestrators: Array<{ id: string; projectId: string; projectName: string }>;
  } = {
    sessions: [],
    globalPause: null,
    orchestrators: [],
  };

  let dispatchPlan: DispatchPlanItem[] = [];
  let harness: HarnessSnapshot = {
    dispatchPlan: [],
    workState: [],
    reconciliationState: [],
    scoreSummaryByTicket: [],
    needsRescore: [],
  };
  let defaultProjectId: string | null = null;

  try {
    const { config, registry, sessionManager } = await getServices();
    defaultProjectId = Object.keys(config.projects ?? {})[0] ?? null;
    harness = await loadHarnessSnapshot(config);
    dispatchPlan = harness.dispatchPlan;
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

  const projectName = getSelectedProjectName(projectFilter);
  const projects = getAllProjects();
  const selectedProjectId = projectFilter === "all" ? undefined : projectFilter;

  return (
    <Dashboard
      initialSessions={pageData.sessions}
      projectId={selectedProjectId}
      projectName={projectName}
      projects={projects}
      initialGlobalPause={pageData.globalPause}
      orchestrators={pageData.orchestrators}
      dispatchPlan={dispatchPlan}
      harness={harness}
      defaultProjectId={defaultProjectId}
    />
  );
}
