import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { DashboardShell } from "@/components/DashboardShell";
import { getAllProjects } from "@/lib/project-name";
import { loadProjectPageData } from "@/lib/project-page-data";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import { getDefaultCloneLocation } from "@/lib/default-location";

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
  const projects = getAllProjects();
  const project = projects.find((p) => p.id === projectFilter);

  if (!project) {
    redirect("/");
  }

  const [pageData, { projectSummaries, sessions: allSessions }] = await Promise.all([
    loadProjectPageData(projectFilter),
    loadPortfolioPageData(),
  ]);
  const projectName = project.name;

  return (
    <DashboardShell
      projects={projectSummaries}
      sessions={allSessions}
      activeProjectId={projectFilter}
      defaultLocation={getDefaultCloneLocation()}
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
