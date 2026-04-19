import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { isPortfolioEnabled } from "@aoagents/ao-core";
import { redirect } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { DashboardShell } from "@/components/DashboardShell";
import { ProjectDegradedState } from "@/components/ProjectDegradedState";
import { getDefaultCloneLocation } from "@/lib/default-location";
import { getAllProjects } from "@/lib/project-name";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import { loadProjectPageData } from "@/lib/project-page-data";

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
  const portfolioEnabled = isPortfolioEnabled();
  const params = await props.params;
  const projectFilter = params.projectId;
  const projects = getAllProjects();
  const project = projects.find((p) => p.id === projectFilter);

  if (!project) {
    redirect("/");
  }

  const portfolioData = await loadPortfolioPageData();
  if (project.degraded) {
    return (
      <DashboardShell
        projects={portfolioData.projectSummaries}
        sessions={portfolioData.sessions}
        activeProjectId={projectFilter}
        defaultLocation={getDefaultCloneLocation()}
        portfolioEnabled={portfolioEnabled}
      >
        <ProjectDegradedState
          projectId={project.id}
          projectName={project.name}
          reason={project.degradedReason}
        />
      </DashboardShell>
    );
  }

  const pageData = await loadProjectPageData(projectFilter);
  const projectName = project.name;

  return (
    <Dashboard
      initialSessions={pageData.sessions}
      sidebarSessions={portfolioData.sessions}
      projectId={projectFilter}
      projectName={projectName}
      projects={projects}
      portfolioEnabled={portfolioEnabled}
      initialGlobalPause={pageData.globalPause}
      orchestrators={pageData.orchestrators}
    />
  );
}
