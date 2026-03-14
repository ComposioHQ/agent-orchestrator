import { buildDashboardHref } from "@/lib/dashboard-route-state";
import type { DashboardOrchestratorLink, DashboardSession } from "@/lib/types";
import type { ProjectOverview } from "../Dashboard";
import { PRInspectionSummary, SessionInspectionSummary } from "../session-inspection";

interface PixelSessionDrawerContentProps {
  allProjectsView: boolean;
  projectOverview?: ProjectOverview | null;
  selectedSession: DashboardSession;
}

export function PixelSessionDrawerContent({
  allProjectsView,
  projectOverview,
  selectedSession,
}: PixelSessionDrawerContentProps) {
  const projectScopedPixelHref = buildDashboardHref("/", {
    project: selectedSession.projectId,
    view: "pixel",
  });

  return (
    <div className="space-y-4">
      {allProjectsView && projectOverview ? (
        <section className="rounded-[14px] border border-[var(--color-border-subtle)] bg-[rgba(15,23,42,0.7)] p-4 text-[var(--color-text-primary)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                Project context
              </div>
              <h3 className="mt-1 text-[15px] font-semibold">{projectOverview.project.name}</h3>
              <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                {projectOverview.sessionCount} active session{projectOverview.sessionCount === 1 ? "" : "s"} ·{" "}
                {projectOverview.openPRCount} open PR
              </p>
            </div>
            <a
              href={projectScopedPixelHref}
              className="rounded-[8px] border border-[rgba(148,163,184,0.28)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[rgba(191,219,254,0.9)] hover:no-underline"
            >
              Open district
            </a>
          </div>
          <div className="mt-3 text-[11px] text-[var(--color-text-muted)]">
            {projectOverview.orchestrator ? "District orchestrator online" : "No district orchestrator"}
          </div>
        </section>
      ) : null}

      <section className="rounded-[14px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
            Selected session
          </div>
          <a
            href={`/sessions/${encodeURIComponent(selectedSession.id)}`}
            className="text-[11px] font-semibold text-[var(--color-accent)] hover:underline"
          >
            Open full session
          </a>
        </div>
        <SessionInspectionSummary compact session={selectedSession} />
      </section>

      {selectedSession.pr ? <PRInspectionSummary compact pr={selectedSession.pr} /> : null}
    </div>
  );
}
