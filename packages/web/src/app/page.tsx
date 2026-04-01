import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { homedir } from "node:os";
import { DashboardShell } from "@/components/DashboardShell";
import { PortfolioPage } from "@/components/PortfolioPage";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";

export const metadata: Metadata = {
  title: { absolute: "ao | Agent Orchestrator" },
};

export default async function Home() {
  const { projectSummaries } = await loadPortfolioPageData();

  return (
    <DashboardShell
      projects={projectSummaries}
      defaultLocation={homedir()}
    >
      <PortfolioPage projectSummaries={projectSummaries} />
    </DashboardShell>
  );
}
