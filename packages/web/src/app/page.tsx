import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { isPortfolioEnabled } from "@aoagents/ao-core";
import { DashboardShell } from "@/components/DashboardShell";
import { PortfolioPage } from "@/components/PortfolioPage";
import { getDefaultCloneLocation } from "@/lib/default-location";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import { getPrimaryProjectId } from "@/lib/project-name";

export const metadata: Metadata = {
  title: { absolute: "ao | Agent Orchestrator" },
};

export default async function Home() {
  const portfolioEnabled = isPortfolioEnabled();
  if (!portfolioEnabled) {
    redirect(`/projects/${encodeURIComponent(getPrimaryProjectId())}`);
  }

  const { projectSummaries, sessions, orphanedSessionCount, orphanedProjectPaths } = await loadPortfolioPageData();

  return (
    <DashboardShell
      projects={projectSummaries}
      sessions={sessions}
      defaultLocation={getDefaultCloneLocation()}
      portfolioEnabled={portfolioEnabled}
    >
      <PortfolioPage
        projectSummaries={projectSummaries}
        orphanedSessionCount={orphanedSessionCount}
        orphanedProjectPaths={orphanedProjectPaths}
      />
    </DashboardShell>
  );
}
