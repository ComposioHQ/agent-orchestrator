"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type AttentionLevel,
  type GlobalPauseState,
  type DashboardOrchestratorLink,
  getAttentionLevel,
  isKilledSession,
  isPRRateLimited,
  CI_STATUS,
} from "@/lib/types";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { ThemeToggle } from "./ThemeToggle";
import type { ProjectInfo } from "@/lib/project-name";
import { EmptyState } from "./Skeleton";
import { DashboardCompactTopBar } from "./DashboardCompactTopBar";
import { useShowKilledSessions } from "@/hooks/useShowKilledSessions";

interface DashboardProps {
  initialSessions: DashboardSession[];
  projectId?: string;
  projectName?: string;
  projects?: ProjectInfo[];
  initialGlobalPause?: GlobalPauseState | null;
  orchestrators?: DashboardOrchestratorLink[];
}

const KANBAN_LEVELS_BASE = ["working", "pending", "review", "respond", "merge", "done"] as const;
const EMPTY_ORCHESTRATORS: DashboardOrchestratorLink[] = [];

function mergeOrchestrators(
  current: DashboardOrchestratorLink[],
  incoming: DashboardOrchestratorLink[],
): DashboardOrchestratorLink[] {
  const merged = new Map(current.map((orchestrator) => [orchestrator.projectId, orchestrator]));

  for (const orchestrator of incoming) {
    merged.set(orchestrator.projectId, orchestrator);
  }

  return [...merged.values()];
}

export function Dashboard({
  initialSessions,
  projectId,
  projectName,
  projects = [],
  initialGlobalPause = null,
  orchestrators,
}: DashboardProps) {
  const orchestratorLinks = orchestrators ?? EMPTY_ORCHESTRATORS;
  const { sessions, globalPause } = useSessionEvents(
    initialSessions,
    initialGlobalPause,
    projectId,
  );
  const searchParams = useSearchParams();
  const activeSessionId = searchParams.get("session") ?? undefined;
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [globalPauseDismissed, setGlobalPauseDismissed] = useState(false);
  const [activeOrchestrators, setActiveOrchestrators] =
    useState<DashboardOrchestratorLink[]>(orchestratorLinks);
  const [spawningProjectIds, setSpawningProjectIds] = useState<string[]>([]);
  const [spawnErrors, setSpawnErrors] = useState<Record<string, string>>({});
  const [showKilled, setShowKilled] = useShowKilledSessions();
  const kanbanLevels = showKilled
    ? ([...KANBAN_LEVELS_BASE, "killed"] as const)
    : KANBAN_LEVELS_BASE;
  const allProjectsView = projects.length > 1 && projectId === undefined;

  const displaySessions = useMemo(() => {
    if (allProjectsView || !activeSessionId) return sessions;
    return sessions.filter((s) => s.id === activeSessionId);
  }, [sessions, allProjectsView, activeSessionId]);

  useEffect(() => {
    setActiveOrchestrators((current) => mergeOrchestrators(current, orchestratorLinks));
  }, [orchestratorLinks]);

  const boardSessions = useMemo(
    () => displaySessions.filter((s) => showKilled || !isKilledSession(s)),
    [displaySessions, showKilled],
  );

  useEffect(() => {
    if (!sheetState || sheetState.mode !== "confirm-kill" || !sheetSession) return;
    if (getAttentionLevel(sheetSession) !== "done") return;
    setSheetState(null);
  }, [sheetSession, sheetState]);

  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
      killed: [],
    };
    for (const session of boardSessions) {
      if (isKilledSession(session)) {
        zones.killed.push(session);
      } else {
        zones[getAttentionLevel(session)].push(session);
      }
    }
    return zones;
  }, [boardSessions]);

  const sessionsByProject = useMemo(() => {
    const groupedSessions = new Map<string, DashboardSession[]>();
    for (const session of sessions) {
      const projectSessions = groupedSessions.get(session.projectId);
      if (projectSessions) {
        projectSessions.push(session);
        continue;
      }
      groupedSessions.set(session.projectId, [session]);
    }
    return groupedSessions;
  }, [sessions]);

  const openPRs = useMemo(() => {
    return displaySessions
      .filter(
        (session): session is DashboardSession & { pr: DashboardPR } =>
          session.pr?.state === "open",
      )
      .map((session) => session.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [displaySessions]);

  const projectOverviews = useMemo(() => {
    if (!allProjectsView) return [];

    return projects.map((project) => {
      const projectSessionsRaw = sessionsByProject.get(project.id) ?? [];
      const projectSessions = projectSessionsRaw.filter(
        (s) => showKilled || !isKilledSession(s),
      );
      const killedCount = projectSessionsRaw.filter(isKilledSession).length;
      const counts: Record<AttentionLevel, number> = {
        merge: 0,
        respond: 0,
        review: 0,
        pending: 0,
        working: 0,
        done: 0,
        killed: 0,
      };

      for (const session of projectSessions) {
        if (isKilledSession(session)) {
          counts.killed++;
        } else {
          counts[getAttentionLevel(session)]++;
        }
      }

      return {
        project,
        orchestrator:
          activeOrchestrators.find((orchestrator) => orchestrator.projectId === project.id) ?? null,
        sessionCount: projectSessions.length,
        openPRCount: projectSessions.filter((session) => session.pr?.state === "open").length,
        killedCount,
        counts,
      };
    });
  }, [activeOrchestrators, allProjectsView, projects, sessionsByProject, showKilled]);

  const handleSend = useCallback(async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Failed to send message to ${sessionId}:`, text);
      showToast(`Send failed: ${text}`, "error");
      throw new Error(text || `Failed to send message to ${sessionId}`);
    }
  }, [showToast]);

  const handleKill = useCallback(async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to kill ${sessionId}:`, await res.text());
    }
  }, []);

  const handleMerge = useCallback(async (prNumber: number) => {
    const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
    if (!res.ok) {
      console.error(`Failed to merge PR #${prNumber}:`, await res.text());
    }
  }, []);

  const handleRestore = useCallback(async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to restore ${sessionId}:`, await res.text());
    }
  }, []);

  const handleSpawnOrchestrator = async (project: ProjectInfo) => {
    setSpawningProjectIds((current) =>
      current.includes(project.id) ? current : [...current, project.id],
    );
    setSpawnErrors(({ [project.id]: _ignored, ...current }) => current);

    try {
      const res = await fetch("/api/orchestrators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });

      const data = (await res.json().catch(() => null)) as {
        orchestrator?: DashboardOrchestratorLink;
        error?: string;
      } | null;

      if (!res.ok || !data?.orchestrator) {
        throw new Error(data?.error ?? `Failed to spawn orchestrator for ${project.name}`);
      }

      const orchestrator = data.orchestrator;

      setActiveOrchestrators((current) => {
        const next = current.filter((orchestrator) => orchestrator.projectId !== project.id);
        next.push(orchestrator);
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to spawn orchestrator";
      setSpawnErrors((current) => ({ ...current, [project.id]: message }));
      console.error(`Failed to spawn orchestrator for ${project.id}:`, error);
    } finally {
      setSpawningProjectIds((current) => current.filter((id) => id !== project.id));
    }
  };

  const hasAnySessions = kanbanLevels.some((level) => grouped[level].length > 0);

  const anyRateLimited = useMemo(
    () => sessions.some((session) => session.pr && isPRRateLimited(session.pr)),
    [sessions],
  );

  const liveStats = useMemo<DashboardStats>(
    () => ({
      totalSessions: sessions.length,
      workingSessions: sessions.filter(
        (session) => session.activity !== null && session.activity !== "exited",
      ).length,
      openPRs: sessions.filter((session) => session.pr?.state === "open").length,
      needsReview: sessions.filter(
        (session) => session.pr && !session.pr.isDraft && session.pr.reviewDecision === "pending",
      ).length,
    }),
    [sessions],
  );

  const resumeAtLabel = useMemo(() => {
    if (!globalPause) return null;
    return new Date(globalPause.pausedUntil).toLocaleString();
  }, [globalPause]);

  useEffect(() => {
    setGlobalPauseDismissed(false);
  }, [globalPause?.pausedUntil, globalPause?.reason, globalPause?.sourceSessionId]);

  return (
    <div className="dashboard-main h-screen overflow-y-auto">
        <DynamicFavicon sessions={sessions} projectName={projectName} />
        <DashboardCompactTopBar
          title={projectName ?? "Orchestrator"}
          subtitle="Live sessions, review pressure, and merge readiness."
          projects={projects}
        >
          <StatusCards stats={liveStats} />
          {!allProjectsView && <OrchestratorControl orchestrators={activeOrchestrators} />}
          <ThemeToggle />
        </DashboardCompactTopBar>

        <div className="px-4 pb-4 pt-5 md:px-7 md:pb-6 md:pt-6">
        {globalPause && !globalPauseDismissed && (
          <div className="dashboard-alert mb-6 flex items-center gap-2.5 border border-[color-mix(in_srgb,var(--color-status-error)_25%,transparent)] bg-[var(--color-tint-red)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-error)]">
            <svg
              className="h-3.5 w-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <span className="flex-1">
              <strong>Orchestrator paused:</strong> {globalPause.reason}
              {resumeAtLabel && (
                <span className="ml-2 opacity-75">Resume after {resumeAtLabel}</span>
              )}
              {globalPause.sourceSessionId && (
                <span className="ml-2 opacity-75">(Source: {globalPause.sourceSessionId})</span>
              )}
            </span>
            <button
              onClick={() => setGlobalPauseDismissed(true)}
              className="ml-1 shrink-0 opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {anyRateLimited && !rateLimitDismissed && (
          <div className="dashboard-alert mb-6 flex items-center gap-2.5 border border-[color-mix(in_srgb,var(--color-status-attention)_25%,transparent)] bg-[var(--color-tint-yellow)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
            <svg
              className="h-3.5 w-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <span className="flex-1">
              GitHub API rate limited — PR data (CI status, review state, sizes) may be stale. Will
              retry automatically on next refresh.
            </span>
            <button
              onClick={() => setRateLimitDismissed(true)}
              className="ml-1 shrink-0 opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {allProjectsView && (
          <>
            <div className="mb-4 flex justify-end">
              <button
                type="button"
                onClick={() => setShowKilled(!showKilled)}
                className="rounded border border-[var(--color-border-default)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]"
              >
                {showKilled ? "Hide killed sessions" : "Show killed sessions"}
              </button>
            </div>
            <ProjectOverviewGrid
              showKilled={showKilled}
              overviews={projectOverviews}
              onSpawnOrchestrator={handleSpawnOrchestrator}
              spawningProjectIds={spawningProjectIds}
              spawnErrors={spawnErrors}
            />
          </>
        )}

        {!allProjectsView && (
          <>
            <div className="mb-4 flex justify-end">
              <button
                type="button"
                onClick={() => setShowKilled(!showKilled)}
                className="rounded border border-[var(--color-border-default)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]"
              >
                {showKilled ? "Hide killed sessions" : "Show killed sessions"}
              </button>
            </div>
            {hasAnySessions ? (
              <div className="kanban-board-wrap">
                <div className="board-section-head">
                  <div>
                    <h2 className="board-section-head__title">Attention Board</h2>
                    <p className="board-section-head__subtitle">
                      Triage by required intervention, not by chronology.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="board-section-head__legend">
                      <BoardLegendItem label="Human action" tone="var(--color-status-error)" />
                      <BoardLegendItem label="Review queue" tone="var(--color-accent-orange)" />
                      <BoardLegendItem label="Ready to land" tone="var(--color-status-ready)" />
                    </div>
                  </div>
                </div>
                <div className="kanban-board">
                  {kanbanLevels.map((level) => (
                    <AttentionZone
                      key={level}
                      level={level}
                      sessions={grouped[level]}
                      onSend={handleSend}
                      onKill={handleKill}
                      onMerge={handleMerge}
                      onRestore={handleRestore}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState />
            )}
          </>
        )}

        {openPRs.length > 0 && (
          <div className="mx-auto max-w-[900px]">
            <h2 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
              Pull Requests
            </h2>
            <div className="overflow-hidden border border-[var(--color-border-default)]">
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
        </div>
    </div>
  );
}

function OrchestratorControl({ orchestrators }: { orchestrators: DashboardOrchestratorLink[] }) {
  if (orchestrators.length === 0) return null;

  if (orchestrators.length === 1) {
    const orchestrator = orchestrators[0];
    return (
      <a
        href={`/sessions/${encodeURIComponent(orchestrator.id)}`}
        className="orchestrator-btn flex items-center gap-2 px-4 py-2 text-[12px] font-semibold hover:no-underline"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
        orchestrator
        <svg
          className="h-3 w-3 opacity-70"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
        </svg>
      </a>
    );
  }

  return (
    <details className="group relative">
      <summary className="orchestrator-btn flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-[12px] font-semibold hover:no-underline">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
        {orchestrators.length} orchestrators
        <svg
          className="h-3 w-3 opacity-70 transition-transform group-open:rotate-90"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </summary>
      <div className="absolute right-0 top-[calc(100%+0.5rem)] z-10 min-w-[220px] overflow-hidden border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] shadow-[0_18px_40px_rgba(0,0,0,0.18)]">
        {orchestrators.map((orchestrator, index) => (
          <a
            key={orchestrator.id}
            href={`/sessions/${encodeURIComponent(orchestrator.id)}`}
            className={`flex items-center justify-between gap-3 px-4 py-3 text-[12px] hover:bg-[var(--color-bg-hover)] hover:no-underline ${
              index > 0 ? "border-t border-[var(--color-border-subtle)]" : ""
            }`}
          >
            <span className="flex min-w-0 items-center gap-2 text-[var(--color-text-primary)]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)] opacity-80" />
              <span className="truncate">{orchestrator.projectName}</span>
            </span>
            <svg
              className="h-3 w-3 shrink-0 opacity-60"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </a>
        ))}
      </div>
    </details>
  );
}

function ProjectOverviewGrid({
  showKilled,
  overviews,
  onSpawnOrchestrator,
  spawningProjectIds,
  spawnErrors,
}: {
  showKilled: boolean;
  overviews: Array<{
    project: ProjectInfo;
    orchestrator: DashboardOrchestratorLink | null;
    sessionCount: number;
    openPRCount: number;
    killedCount: number;
    counts: Record<AttentionLevel, number>;
  }>;
  onSpawnOrchestrator: (project: ProjectInfo) => Promise<void>;
  spawningProjectIds: string[];
  spawnErrors: Record<string, string>;
}) {
  return (
    <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {overviews.map(({ project, orchestrator, sessionCount, openPRCount, killedCount, counts }) => (
        <section
          key={project.id}
          className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4"
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
              href={`/?project=${encodeURIComponent(project.id)}`}
              className="border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:no-underline"
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
            {showKilled ? (
              <ProjectMetric
                label="Killed"
                value={killedCount}
                tone="var(--color-status-error)"
              />
            ) : null}
          </div>

          <div className="border-t border-[var(--color-border-subtle)] pt-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {orchestrator ? "Per-project orchestrator available" : "No running orchestrator"}
              </div>
              {orchestrator ? (
                <a
                  href={`/sessions/${encodeURIComponent(orchestrator.id)}`}
                  className="orchestrator-btn flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold hover:no-underline"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
                  orchestrator
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => void onSpawnOrchestrator(project)}
                  disabled={spawningProjectIds.includes(project.id)}
                  className="orchestrator-btn px-3 py-1.5 text-[11px] font-semibold disabled:cursor-wait disabled:opacity-70"
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
    <div className="min-w-[78px] border border-[var(--color-border-subtle)] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-1 text-[18px] font-semibold tabular-nums" style={{ color: tone }}>
        {value}
      </div>
    </div>
  );
}

function StatusCards({ stats }: { stats: DashboardStats }) {
  if (stats.totalSessions === 0) {
    return (
      <div className="dashboard-stat-cards">
        <div className="dashboard-stat-card dashboard-stat-card--empty">
          <span className="dashboard-stat-card__label">Fleet</span>
          <span className="dashboard-stat-card__value">0</span>
          <span className="dashboard-stat-card__meta">No live sessions</span>
        </div>
      </div>
    );
  }

  const parts: Array<{ value: number; label: string; meta: string; tone?: string }> = [
    { value: stats.totalSessions, label: "Fleet", meta: "Live sessions" },
    {
      value: stats.workingSessions,
      label: "Active",
      meta: "Currently moving",
      tone: "var(--color-status-working)",
    },
    { value: stats.openPRs, label: "PRs", meta: "Open pull requests" },
    {
      value: stats.needsReview,
      label: "Review",
      meta: "Awaiting eyes",
      tone: "var(--color-status-attention)",
    },
  ];

  return (
    <div className="dashboard-stat-cards">
      {parts.map((part) => (
        <div key={part.label} className="dashboard-stat-card">
          <span
            className="dashboard-stat-card__value"
            style={{ color: part.tone ?? "var(--color-text-primary)" }}
          >
            {part.value}
          </span>
          <span className="dashboard-stat-card__label">{part.label}</span>
          <span className="dashboard-stat-card__meta">{part.meta}</span>
        </div>
      ))}
    </div>
  );
}

function BoardLegendItem({ label, tone }: { label: string; tone: string }) {
  return (
    <span className="board-legend-item">
      <span className="board-legend-item__dot" style={{ background: tone }} />
      {label}
    </span>
  );
}

function mergeScore(
  pr: Pick<DashboardPR, "ciStatus" | "reviewDecision" | "mergeability" | "unresolvedThreads">,
): number {
  let score = 0;
  if (!pr.mergeability.noConflicts) score += 40;
  if (pr.ciStatus === CI_STATUS.FAILING) score += 30;
  else if (pr.ciStatus === CI_STATUS.PENDING) score += 5;
  if (pr.reviewDecision === "changes_requested") score += 20;
  else if (pr.reviewDecision !== "approved") score += 10;
  score += pr.unresolvedThreads * 5;
  return score;
}
