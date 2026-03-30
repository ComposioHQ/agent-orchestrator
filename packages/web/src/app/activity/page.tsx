import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { homedir } from "node:os";
import { ActivityFeedPage } from "@/components/ActivityFeedPage";
import { DashboardShell } from "@/components/DashboardShell";
import { loadHomeActivityData } from "@/lib/home-activity-data";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";

export const metadata: Metadata = {
  title: { absolute: "ao | Activity" },
};

export default async function ActivityPage() {
  const [{ projectSummaries }, { activityItems }] = await Promise.all([
    loadPortfolioPageData(),
    loadHomeActivityData(),
  ]);

  return (
    <DashboardShell projects={projectSummaries} defaultLocation={homedir()}>
      <ActivityFeedPage projectSummaries={projectSummaries} activityItems={activityItems} />
    </DashboardShell>
  );
}
