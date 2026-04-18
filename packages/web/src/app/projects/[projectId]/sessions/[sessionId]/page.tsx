import { isPortfolioEnabled } from "@aoagents/ao-core";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/DashboardShell";
import { ProjectDegradedState } from "@/components/ProjectDegradedState";
import { ProjectSessionPageClient } from "@/components/ProjectSessionPageClient";
import { getDefaultCloneLocation } from "@/lib/default-location";
import { loadProjectPageData } from "@/lib/project-page-data";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import { getAllProjects } from "@/lib/project-name";

export const dynamic = "force-dynamic";

export default async function ProjectSessionPage(props: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const portfolioEnabled = isPortfolioEnabled();
  const params = await props.params;
  const project = getAllProjects().find((candidate) => candidate.id === params.projectId);

  if (!project) {
    redirect("/");
  }

  const [{ projectSummaries, sessions: allSessions }] = await Promise.all([
    loadPortfolioPageData(),
    loadProjectPageData(params.projectId, {
      ensureOrchestrator: false,
      includeMetadata: false,
      includePullRequests: false,
    }),
  ]);

  if (project.degraded) {
    return (
      <DashboardShell
        projects={projectSummaries}
        sessions={allSessions}
        activeProjectId={params.projectId}
        activeSessionId={params.sessionId}
        defaultLocation={getDefaultCloneLocation()}
        portfolioEnabled={portfolioEnabled}
      >
        <ProjectDegradedState
          projectId={project.id}
          projectName={project.name}
          reason={project.degradedReason}
          compact
        />
      </DashboardShell>
    );
  }

  return (
    <DashboardShell
      projects={projectSummaries}
      sessions={allSessions}
      activeProjectId={params.projectId}
      activeSessionId={params.sessionId}
      defaultLocation={getDefaultCloneLocation()}
      portfolioEnabled={portfolioEnabled}
    >
      <ProjectSessionPageClient projectId={params.projectId} sessionId={params.sessionId} />
    </DashboardShell>
  );
}
