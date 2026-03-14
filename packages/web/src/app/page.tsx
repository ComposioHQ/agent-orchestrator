import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { Dashboard } from "@/components/Dashboard";
import { buildDashboardPayload } from "@/lib/dashboard-data";
import { parseDashboardRouteState } from "@/lib/dashboard-route-state";
import { getPrimaryProjectId, getProjectName, getAllProjects } from "@/lib/project-name";

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
  searchParams: Promise<{ project?: string; view?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const routeState = parseDashboardRouteState(searchParams);
  const projectFilter = routeState.project ?? getPrimaryProjectId();
  const projectName = getSelectedProjectName(projectFilter);
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function Home(props: {
  searchParams: Promise<{ project?: string; view?: string }>;
}) {
  const searchParams = await props.searchParams;
  const routeState = parseDashboardRouteState(searchParams);
  const projectFilter = routeState.project ?? getPrimaryProjectId();
  const pageData = await buildDashboardPayload({
    projectFilter,
    view: routeState.view,
  }).catch(() => ({
    sessions: [],
    stats: {
      totalSessions: 0,
      workingSessions: 0,
      openPRs: 0,
      needsReview: 0,
    },
    globalPause: null,
    orchestrators: [],
    view: routeState.view,
  }));

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
      view={pageData.view}
    />
  );
}
