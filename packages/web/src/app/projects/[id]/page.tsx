import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import {
  getDashboardPageData,
  getDashboardProjectName,
} from "@/lib/dashboard-page-data";
import { getAllProjects } from "@/lib/project-name";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await props.params;
  const projectName = getDashboardProjectName(id);
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function ProjectPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const projects = getAllProjects();

  // Validate project exists — redirect to home if not
  if (!projects.some((p) => p.id === id)) {
    redirect("/");
  }

  const pageData = await getDashboardPageData(id);

  return (
    <Dashboard
      initialSessions={pageData.sessions}
      projectId={id}
      projectName={pageData.projectName}
      projects={pageData.projects}
      initialGlobalPause={pageData.globalPause}
      orchestrators={pageData.orchestrators}
    />
  );
}
