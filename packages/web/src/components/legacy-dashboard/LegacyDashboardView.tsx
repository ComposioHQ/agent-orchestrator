import { AttentionZone } from "@/components/AttentionZone";
import { PRTableRow } from "@/components/PRStatus";
import type {
  AttentionLevel,
  DashboardPR,
  DashboardSession,
  DashboardView,
} from "@/lib/types";
import { buildDashboardHref } from "@/lib/dashboard-route-state";
import type { ProjectInfo } from "@/lib/project-name";
import type { ProjectOverview } from "../Dashboard";

const KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;

interface LegacyDashboardViewProps {
  allProjectsView: boolean;
  grouped: Record<AttentionLevel, DashboardSession[]>;
  onKill: (sessionId: string) => Promise<void>;
  onMerge: (prNumber: number) => Promise<void>;
  onRestore: (sessionId: string) => Promise<void>;
  onSend: (sessionId: string, message: string) => Promise<void>;
  onSpawnOrchestrator: (project: ProjectInfo) => Promise<void>;
  openPRs: DashboardPR[];
  projectOverviews: ProjectOverview[];
  spawnErrors: Record<string, string>;
  spawningProjectIds: string[];
  view: DashboardView;
}

export function LegacyDashboardView({
  allProjectsView,
  grouped,
  onKill,
  onMerge,
  onRestore,
  onSend,
  onSpawnOrchestrator,
  openPRs,
  projectOverviews,
  spawnErrors,
  spawningProjectIds,
  view,
}: LegacyDashboardViewProps) {
  const hasKanbanSessions = KANBAN_LEVELS.some((level) => grouped[level].length > 0);

  return (
    <>
      {allProjectsView && (
        <ProjectOverviewGrid
          overviews={projectOverviews}
          onSpawnOrchestrator={onSpawnOrchestrator}
          spawnErrors={spawnErrors}
          spawningProjectIds={spawningProjectIds}
          view={view}
        />
      )}

      {!allProjectsView && hasKanbanSessions && (
        <div className="mb-8 flex gap-4 overflow-x-auto pb-2">
          {KANBAN_LEVELS.map((level) =>
            grouped[level].length > 0 ? (
              <div key={level} className="min-w-[200px] flex-1">
                <AttentionZone
                  level={level}
                  sessions={grouped[level]}
                  variant="column"
                  onSend={onSend}
                  onKill={onKill}
                  onMerge={onMerge}
                  onRestore={onRestore}
                />
              </div>
            ) : null,
          )}
        </div>
      )}

      {!allProjectsView && grouped.done.length > 0 && (
        <div className="mb-8">
          <AttentionZone
            level="done"
            sessions={grouped.done}
            variant="grid"
            onSend={onSend}
            onKill={onKill}
            onMerge={onMerge}
            onRestore={onRestore}
          />
        </div>
      )}

      {openPRs.length > 0 && (
        <div className="mx-auto max-w-[900px]">
          <h2 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Pull Requests
          </h2>
          <div className="overflow-hidden rounded-[6px] border border-[var(--color-border-default)]">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-border-muted)]">
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    PR
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Title
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Size
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    CI
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Review
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Unresolved
                  </th>
                </tr>
              </thead>
              <tbody>
                {openPRs.map((pr) => (
                  <PRTableRow key={pr.number} pr={pr} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function ProjectOverviewGrid({
  overviews,
  onSpawnOrchestrator,
  spawnErrors,
  spawningProjectIds,
  view,
}: {
  overviews: ProjectOverview[];
  onSpawnOrchestrator: (project: ProjectInfo) => Promise<void>;
  spawnErrors: Record<string, string>;
  spawningProjectIds: string[];
  view: DashboardView;
}) {
  return (
    <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {overviews.map(({ project, orchestrator, sessionCount, openPRCount, counts }) => (
        <section
          key={project.id}
          className="rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                {project.name}
              </h2>
              <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                {sessionCount} active session{sessionCount !== 1 ? "s" : ""}
                {openPRCount > 0 ? ` · ${openPRCount} open PR${openPRCount !== 1 ? "s" : ""}` : ""}
              </div>
            </div>
            <a
              href={buildDashboardHref("/", { project: project.id, view })}
              className="rounded-[7px] border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:no-underline"
            >
              Open project
            </a>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
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
              {orchestrator ? (
                <a
                  href={`/sessions/${encodeURIComponent(orchestrator.id)}`}
                  className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-3 py-1.5 text-[11px] font-semibold hover:no-underline"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
                  orchestrator
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => void onSpawnOrchestrator(project)}
                  disabled={spawningProjectIds.includes(project.id)}
                  className="orchestrator-btn rounded-[7px] px-3 py-1.5 text-[11px] font-semibold disabled:cursor-wait disabled:opacity-70"
                >
                  {spawningProjectIds.includes(project.id) ? "Spawning..." : "Spawn Orchestrator"}
                </button>
              )}
            </div>
            {spawnErrors[project.id] ? (
              <p className="mt-2 text-[11px] text-[var(--color-status-error)]">
                {spawnErrors[project.id]}
              </p>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}

function ProjectMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-[78px] rounded-[8px] border border-[var(--color-border-subtle)] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-1 text-[18px] font-semibold tabular-nums" style={{ color: tone }}>
        {value}
      </div>
    </div>
  );
}
