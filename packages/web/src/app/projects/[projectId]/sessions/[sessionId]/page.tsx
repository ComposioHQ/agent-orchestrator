import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/DashboardShell";
import { ProjectSessionPageClient } from "@/components/ProjectSessionPageClient";
import { getDefaultCloneLocation } from "@/lib/default-location";
import { loadProjectPageData } from "@/lib/project-page-data";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import { getAllProjects } from "@/lib/project-name";

export const dynamic = "force-dynamic";

export default async function ProjectSessionPage(props: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const params = await props.params;
  const project = getAllProjects().find((candidate) => candidate.id === params.projectId);

  if (!project) {
    redirect("/");
  }

  const [{ projectSummaries, sessions: allSessions }, projectPageData] = await Promise.all([
    loadPortfolioPageData(),
    loadProjectPageData(params.projectId),
  ]);

  return (
    <DashboardShell
      projects={projectSummaries}
      sessions={allSessions}
      activeProjectId={params.projectId}
      activeSessionId={params.sessionId}
      defaultLocation={getDefaultCloneLocation()}
    >
      <ProjectSessionPageClient projectId={params.projectId} sessionId={params.sessionId} />
    </DashboardShell>
  );
}
