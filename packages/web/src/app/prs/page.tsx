import type { Metadata } from "next";
import { isPortfolioEnabled } from "@aoagents/ao-core";
import { redirect } from "next/navigation";
import { PullRequestsPage } from "@/components/PullRequestsPage";
import { DashboardShell } from "@/components/DashboardShell";
import { getDefaultCloneLocation } from "@/lib/default-location";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import {
  getDashboardPageData,
  getDashboardProjectName,
  resolveDashboardProjectFilter,
} from "@/lib/dashboard-page-data";
import { getPrimaryProjectId } from "@/lib/project-name";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const projectName = getDashboardProjectName(projectFilter);
  return { title: { absolute: `ao | ${projectName} PRs` } };
}

export default async function PullRequestsRoute(props: {
  searchParams: Promise<{ project?: string }>;
}) {
  const portfolioEnabled = isPortfolioEnabled();
  if (!portfolioEnabled) {
    redirect(`/projects/${encodeURIComponent(getPrimaryProjectId())}`);
  }

  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const [pageData, { projectSummaries, sessions }] = await Promise.all([
    getDashboardPageData(projectFilter),
    loadPortfolioPageData(),
  ]);

  return (
    <DashboardShell
      projects={projectSummaries}
      sessions={sessions}
      defaultLocation={getDefaultCloneLocation()}
      portfolioEnabled={portfolioEnabled}
    >
      <PullRequestsPage
        initialSessions={pageData.sessions}
        projectId={pageData.selectedProjectId}
        projectName={pageData.projectName}
        projects={pageData.projects}
        orchestrators={pageData.orchestrators}
      />
    </DashboardShell>
  );
}
