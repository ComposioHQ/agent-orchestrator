import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { isPortfolioEnabled } from "@aoagents/ao-core";
import { redirect } from "next/navigation";
import { ActivityFeedPage } from "@/components/ActivityFeedPage";
import { DashboardShell } from "@/components/DashboardShell";
import { getDefaultCloneLocation } from "@/lib/default-location";
import { loadHomeActivityData } from "@/lib/home-activity-data";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import { getPrimaryProjectId } from "@/lib/project-name";

export const metadata: Metadata = {
  title: { absolute: "ao | Activity" },
};

export default async function ActivityPage() {
  const portfolioEnabled = isPortfolioEnabled();
  if (!portfolioEnabled) {
    redirect(`/projects/${encodeURIComponent(getPrimaryProjectId())}`);
  }

  const [{ projectSummaries, sessions }, { activityItems }] = await Promise.all([
    loadPortfolioPageData(),
    loadHomeActivityData(),
  ]);

  return (
    <DashboardShell
      projects={projectSummaries}
      sessions={sessions}
      defaultLocation={getDefaultCloneLocation()}
      portfolioEnabled={portfolioEnabled}
    >
      <ActivityFeedPage projectSummaries={projectSummaries} activityItems={activityItems} />
    </DashboardShell>
  );
}
