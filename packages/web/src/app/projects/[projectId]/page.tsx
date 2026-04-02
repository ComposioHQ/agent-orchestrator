import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { Dashboard } from "@/components/Dashboard";
import { getAllProjects } from "@/lib/project-name";
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
  const params = await props.params;
  const projectFilter = params.projectId;

  const pageData = await loadProjectPageData(projectFilter);

  const projects = getAllProjects();
  const project = projects.find(p => p.id === projectFilter);
  const projectName = project?.name ?? projectFilter;

  return (
    <Dashboard
      initialSessions={pageData.sessions}
      projectId={projectFilter}
      projectName={projectName}
      projects={projects}
      initialGlobalPause={pageData.globalPause}
      orchestrators={pageData.orchestrators}
    />
  );
}
