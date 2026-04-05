import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { DashboardShell } from "@/components/DashboardShell";
import { PortfolioPage } from "@/components/PortfolioPage";
import { getDefaultCloneLocation } from "@/lib/default-location";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";

export const metadata: Metadata = {
  title: { absolute: "ao | Agent Orchestrator" },
};

export default async function Home() {
  const { projectSummaries, sessions, orphanedSessionCount } = await loadPortfolioPageData();

  return (
    <DashboardShell
      projects={projectSummaries}
      sessions={sessions}
      defaultLocation={getDefaultCloneLocation()}
    >
      <PortfolioPage projectSummaries={projectSummaries} orphanedSessionCount={orphanedSessionCount} />
    </DashboardShell>
  );
}
