import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { Dashboard } from "@/components/Dashboard";
import { getAllProjects } from "@/lib/project-name";
import { fetchDashboardData } from "@/lib/dashboard-data";

export async function generateMetadata(props: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await props.params;
  const projects = getAllProjects();
  const project = projects.find((p) => p.id === id);
  const name = project?.name ?? id;
  return { title: { absolute: `ao | ${name}` } };
}

export default async function ProjectPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const pageData = await fetchDashboardData(id);
  const projects = getAllProjects();
  const project = projects.find((p) => p.id === id);
  const projectName = project?.name ?? id;

  return (
    <Dashboard
      initialSessions={pageData.sessions}
      projectId={id}
      projectName={projectName}
      projects={projects}
      initialGlobalPause={pageData.globalPause}
      orchestrators={pageData.orchestrators}
    />
  );
}
