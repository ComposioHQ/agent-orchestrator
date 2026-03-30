import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { Dashboard } from "@/components/Dashboard";
import { PortfolioPage } from "@/components/PortfolioPage";
import {
  getDashboardPageData,
  getDashboardProjectName,
  resolveDashboardProjectFilter,
} from "@/lib/dashboard-page-data";
import { getAllProjects } from "@/lib/project-name";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const projectName = getDashboardProjectName(projectFilter);
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function Home(props: { searchParams: Promise<{ project?: string }> }) {
  const searchParams = await props.searchParams;
  const projects = getAllProjects();

  // If no project filter and multiple projects, show portfolio
  if (!searchParams.project && projects.length > 1) {
    const initialCards = projects.map((p) => ({
      id: p.id,
      name: p.name,
      sessionCounts: { total: 0, working: 0, pending: 0, review: 0, respond: 0, ready: 0 },
    }));
    return <PortfolioPage projects={projects} initialCards={initialCards} />;
  }

  // Single project or explicit project filter: show project dashboard
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const pageData = await getDashboardPageData(projectFilter);

  return (
    <Dashboard
      initialSessions={pageData.sessions}
      projectId={pageData.selectedProjectId}
      projectName={pageData.projectName}
      projects={pageData.projects}
      initialGlobalPause={pageData.globalPause}
      orchestrators={pageData.orchestrators}
    />
  );
}
