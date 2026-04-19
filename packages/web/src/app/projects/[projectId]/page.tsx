import Link from "next/link";
import { notFound } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { DegradedProjectState } from "@/components/DegradedProjectState";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getProjectRouteData } from "@/lib/project-route-data";

export const dynamic = "force-dynamic";

export default async function ProjectPage(props: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await props.params;
  const routeData = await getProjectRouteData(projectId);

  if (!routeData) {
    notFound();
  }

  if (routeData.degradedProject) {
    return (
      <DegradedProjectState
        projectId={routeData.projectId}
        resolveError={routeData.degradedProject.resolveError}
        projectPath={routeData.degradedProject.path}
      />
    );
  }

  const pageData = await getDashboardPageData(projectId);

  return (
    <div className="min-h-screen bg-[var(--color-bg-canvas)]">
      <div className="border-b border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-6 py-3">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4">
          <nav className="flex items-center gap-2 text-sm text-[var(--color-text-tertiary)]">
            <Link href="/" className="hover:text-[var(--color-text-primary)]">
              Portfolio
            </Link>
            <span>/</span>
            <span className="text-[var(--color-text-primary)]">{pageData.projectName}</span>
          </nav>
          <Link
            href={`/projects/${encodeURIComponent(projectId)}/settings`}
            className="rounded-lg border border-[var(--color-border-default)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
          >
            Project settings
          </Link>
        </div>
      </div>
      <Dashboard
        initialSessions={pageData.sessions}
        projectId={pageData.selectedProjectId}
        projectName={pageData.projectName}
        projects={pageData.projects}
        orchestrators={pageData.orchestrators}
        attentionZones={pageData.attentionZones}
      />
    </div>
  );
}
