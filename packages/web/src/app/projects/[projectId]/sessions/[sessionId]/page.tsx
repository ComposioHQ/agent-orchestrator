import { homedir } from "node:os";
import { DashboardShell } from "@/components/DashboardShell";
import { ProjectSessionPageClient } from "@/components/ProjectSessionPageClient";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";

export const dynamic = "force-dynamic";

export default async function ProjectSessionPage(props: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const params = await props.params;
  const { projectSummaries } = await loadPortfolioPageData();

  return (
    <DashboardShell
      projects={projectSummaries}
      activeProjectId={params.projectId}
      activeSessionId={params.sessionId}
      defaultLocation={homedir()}
    >
      <ProjectSessionPageClient projectId={params.projectId} sessionId={params.sessionId} />
    </DashboardShell>
  );
}
