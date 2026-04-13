import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { PhaseKanban } from "@/components/PhaseKanban";
import {
  getDashboardPageData,
  getDashboardProjectName,
  resolveDashboardProjectFilter,
} from "@/lib/dashboard-page-data";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const projectName = getDashboardProjectName(projectFilter);
  return { title: { absolute: `ao | Kanban — ${projectName}` } };
}

export default async function PhasesPage(props: {
  searchParams: Promise<{ project?: string; subphases?: string }>;
}) {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const pageData = await getDashboardPageData(projectFilter);

  return (
    <PhaseKanban
      initialSessions={pageData.sessions}
      projectId={pageData.selectedProjectId}
      projectName={pageData.projectName}
      projects={pageData.projects}
      orchestrators={pageData.orchestrators}
    />
  );
}
