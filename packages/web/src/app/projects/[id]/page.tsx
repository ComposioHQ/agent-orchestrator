import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { Dashboard } from "@/components/Dashboard";
import {
  getDashboardPageData,
  getDashboardProjectName,
} from "@/lib/dashboard-page-data";

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
  const pageData = await getDashboardPageData(id);

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
