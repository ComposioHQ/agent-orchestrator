import { useMemo } from "react";
import type {
  DashboardPR,
  DashboardSession,
} from "@/lib/types";
import { ATTENTION_LEVEL_ORDER, getAttentionLevel } from "@/lib/types";
import { buildDashboardHref } from "@/lib/dashboard-route-state";
import type { ProjectInfo } from "@/lib/project-name";
import type { ProjectOverview } from "../Dashboard";
import type { DashboardTrust } from "../Dashboard";
import { PixelSessionDrawer } from "./PixelSessionDrawer";
import { PixelWorldScene } from "./PixelWorldScene";

interface PixelDashboardViewProps {
  allProjectsView: boolean;
  dashboardTrust: DashboardTrust;
  onKill: (sessionId: string) => Promise<unknown>;
  onMerge: (prNumber: number) => Promise<unknown>;
  onRefreshNow: () => void;
  onSpawnOrchestrator: (project: ProjectInfo) => Promise<void>;
  onRestore: (sessionId: string) => Promise<unknown>;
  onSend: (sessionId: string, message: string) => Promise<unknown>;
  onSelectSession: (sessionId: string | null) => void;
  openPRs: DashboardPR[];
  projectName?: string;
  projectOverviews: ProjectOverview[];
  projects: ProjectInfo[];
  selectedSessionId: string | null;
  sessions: DashboardSession[];
  sessionsByProject: Map<string, DashboardSession[]>;
  spawnErrors: Record<string, string>;
  spawningProjectIds: string[];
}

export function PixelDashboardView({
  allProjectsView,
  dashboardTrust,
  onKill,
  onMerge,
  onRefreshNow,
  onSpawnOrchestrator,
  onRestore,
  onSend,
  onSelectSession,
  openPRs,
  projectName,
  projectOverviews,
  projects,
  selectedSessionId,
  sessions,
  sessionsByProject,
  spawnErrors,
  spawningProjectIds,
}: PixelDashboardViewProps) {
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );
  const selectedProjectOverview = useMemo(
    () =>
      selectedSession
        ? projectOverviews.find((overview) => overview.project.id === selectedSession.projectId) ?? null
        : null,
    [projectOverviews, selectedSession],
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          <SceneStat label="Workers" value={sessions.length} />
          <SceneStat label="Open PRs" value={openPRs.length} />
          <SceneStat
            label="Needs Response"
            value={sessions.filter((session) => getAttentionLevel(session) === "respond").length}
          />
          <SceneStat
            label="Merge Ready"
            value={sessions.filter((session) => getAttentionLevel(session) === "merge").length}
          />
        </div>

        {(dashboardTrust.paused ||
          dashboardTrust.limited ||
          dashboardTrust.alignment.status !== "aligned") && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[rgba(148,163,184,0.24)] bg-[rgba(8,15,27,0.45)] px-4 py-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[rgba(191,219,254,0.75)]">
                Pixel trust state
              </div>
              <p className="mt-1 text-[13px] text-[rgba(226,232,240,0.88)]">
                {dashboardTrust.summary}
              </p>
            </div>
            <button
              type="button"
              onClick={onRefreshNow}
              className="rounded-[9px] border border-[rgba(147,197,253,0.35)] px-3 py-2 text-[12px] font-semibold text-[rgba(219,234,254,0.96)]"
            >
              Refresh shared state
            </button>
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,34vw)] 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <PixelWorldScene
          allProjectsView={allProjectsView}
          dashboardTrust={dashboardTrust}
          onSelectSession={onSelectSession}
          onRefreshNow={onRefreshNow}
          projectName={projectName}
          projects={projects}
          selectedSessionId={selectedSessionId}
          sessions={sessions}
        />
        <PixelSessionDrawer
          allProjectsView={allProjectsView}
          dashboardTrust={dashboardTrust}
          onClose={() => onSelectSession(null)}
          onKill={onKill}
          onMerge={onMerge}
          onRestore={onRestore}
          onSend={onSend}
          projectOverview={selectedProjectOverview}
          selectedSession={selectedSession}
        />
      </div>

      {allProjectsView ? (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {projectOverviews.map(({ project, orchestrator, counts, openPRCount, sessionCount }) => (
            <section
              key={project.id}
              className="rounded-[16px] border border-[var(--color-border-default)] bg-[linear-gradient(180deg,rgba(17,24,39,0.98),rgba(15,23,42,0.92))] p-4 text-[var(--color-text-primary)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                    District
                  </div>
                  <h3 className="mt-1 text-[17px] font-semibold">{project.name}</h3>
                  <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                    {sessionCount} active session{sessionCount !== 1 ? "s" : ""} · {openPRCount} open PR
                  </p>
                </div>
                <a
                  href={buildDashboardHref("/", { project: project.id, view: "pixel" })}
                  className="rounded-[8px] border border-[rgba(148,163,184,0.28)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[rgba(191,219,254,0.9)] hover:no-underline"
                >
                  Enter
                </a>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2">
                {ATTENTION_LEVEL_ORDER.map((level) => (
                  <div
                    key={level}
                    className="rounded-[10px] border border-[rgba(148,163,184,0.18)] bg-[rgba(15,23,42,0.66)] px-3 py-2"
                  >
                    <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                      {level}
                    </div>
                    <div className="mt-1 text-[18px] font-semibold tabular-nums">{counts[level]}</div>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-between gap-3 border-t border-[rgba(148,163,184,0.14)] pt-3">
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  {orchestrator ? "District orchestrator online" : "No district orchestrator"}
                </span>
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
            </section>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <section className="rounded-[16px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                  Active district
                </div>
                <h3 className="mt-1 text-[16px] font-semibold text-[var(--color-text-primary)]">
                  {projectName ?? "Project"}
                </h3>
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                Shared live contract, bounded pixel body
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {ATTENTION_LEVEL_ORDER.filter((level) =>
                sessions.some((session) => getAttentionLevel(session) === level),
              ).map((level) => (
                <div
                  key={level}
                  className="rounded-[12px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]/80 p-3"
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                      {level} lane
                    </span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      {sessions.filter((session) => getAttentionLevel(session) === level).length}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {sessions
                      .filter((session) => getAttentionLevel(session) === level)
                      .slice(0, 4)
                      .map((session) => (
                        <div
                          key={session.id}
                          className="rounded-[10px] border border-[var(--color-border-subtle)] px-3 py-2"
                        >
                          <div className="truncate text-[12px] font-semibold text-[var(--color-text-primary)]">
                            {session.summary || session.id}
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-[var(--color-text-muted)]">
                            <span>{session.branch ?? "no branch"}</span>
                            <span>{session.issueLabel ?? "no issue"}</span>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-[16px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
              Nearby districts
            </div>
            <div className="mt-4 space-y-3">
              {[...sessionsByProject.entries()].map(([projectId, projectSessions]) => (
                <a
                  key={projectId}
                  href={buildDashboardHref("/", { project: projectId, view: "pixel" })}
                  className="block rounded-[12px] border border-[var(--color-border-subtle)] px-3 py-3 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] hover:no-underline"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold">{projectId}</span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      {projectSessions.length} sessions
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                    {ATTENTION_LEVEL_ORDER.map((level) => {
                      const count = projectSessions.filter(
                        (session) => getAttentionLevel(session) === level,
                      ).length;
                      return count > 0 ? <span key={level}>{level}: {count}</span> : null;
                    })}
                  </div>
                </a>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function SceneStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[12px] border border-[rgba(148,163,184,0.2)] bg-[rgba(15,23,42,0.55)] px-3 py-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[rgba(191,219,254,0.75)]">
        {label}
      </div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums text-white">{value}</div>
    </div>
  );
}
