import type { AttentionLevel, DashboardOrchestratorLink } from "@/lib/types";
import type { ProjectInfo } from "@/lib/project-name";
import { ProjectMetric } from "./ProjectMetric";
import { SpawnOrchestratorButton } from "./SpawnOrchestratorButton";
import { EmptyState } from "./EmptyState";

export interface ProjectOverview {
  project: ProjectInfo;
  orchestrator: DashboardOrchestratorLink | null;
  sessionCount: number;
  openPRCount: number;
  counts: Record<AttentionLevel, number>;
}

export function ProjectOverviewGrid({
  overviews,
  onSpawnOrchestrator,
  spawningProjectIds,
  spawnErrors,
}: {
  overviews: ProjectOverview[];
  onSpawnOrchestrator: (project: ProjectInfo) => Promise<void>;
  spawningProjectIds: string[];
  spawnErrors: Record<string, string>;
}) {
  if (overviews.length === 0) {
    return (
      <div className="mb-8">
        <EmptyState
          icon={
            <svg className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M2 20h20M5 20V10l7-6 7 6v10M9 20v-5h6v5" />
            </svg>
          }
          message="No projects configured"
          description="Add a project to get started with the orchestrator."
          action={
            <p className="text-[11px] text-[var(--color-text-tertiary)]">
              Run{" "}
              <code className="rounded bg-[rgba(255,255,255,0.06)] px-1 py-0.5 font-[var(--font-mono)] text-[10px]">
                ao init &lt;path&gt;
              </code>{" "}
              to add a project
            </p>
          }
        />
      </div>
    );
  }

  return (
    <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
      {overviews.map(({ project, orchestrator, sessionCount, openPRCount, counts }) => (
        <section
          key={project.id}
          className="rounded-[var(--radius-xl)] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                {project.name}
              </h2>
              <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                {sessionCount} active session{sessionCount !== 1 ? "s" : ""}
                {openPRCount > 0 ? ` \u00b7 ${openPRCount} open PR${openPRCount !== 1 ? "s" : ""}` : ""}
              </div>
            </div>
            <a
              href={`/projects/${encodeURIComponent(project.id)}`}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:no-underline"
            >
              Open project
            </a>
          </div>

          <div className="mb-4 grid grid-cols-5 gap-1">
            <ProjectMetric label="Merge" value={counts.merge} tone="var(--color-status-ready)" />
            <ProjectMetric
              label="Respond"
              value={counts.respond}
              tone="var(--color-status-error)"
            />
            <ProjectMetric label="Review" value={counts.review} tone="var(--color-accent-orange)" />
            <ProjectMetric
              label="Pending"
              value={counts.pending}
              tone="var(--color-status-attention)"
            />
            <ProjectMetric
              label="Working"
              value={counts.working}
              tone="var(--color-status-working)"
            />
          </div>

          <div className="border-t border-[var(--color-border-subtle)] pt-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {orchestrator ? "Per-project orchestrator available" : "No running orchestrator"}
              </div>
              <SpawnOrchestratorButton
                project={project}
                orchestrator={orchestrator}
                onSpawnOrchestrator={onSpawnOrchestrator}
                isSpawning={spawningProjectIds.includes(project.id)}
                error={spawnErrors[project.id]}
                variant="compact"
              />
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
