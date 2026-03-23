"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type AttentionLevel,
  type GlobalPauseState,
  type DashboardOrchestratorLink,
  getAttentionLevel,
  isPRRateLimited,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { AttentionZone } from "./AttentionZone";
import { DynamicFavicon } from "./DynamicFavicon";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useDashboardActions } from "@/hooks/useDashboardActions";
import { ProjectSidebar } from "./ProjectSidebar";
import type { ProjectInfo } from "@/lib/project-name";
import { StatusLine } from "./StatusLine";
import { SpawnOrchestratorButton } from "./SpawnOrchestratorButton";
import { ProjectOverviewGrid } from "./ProjectOverviewGrid";
import { GlobalPauseBanner } from "./GlobalPauseBanner";
import { RateLimitBanner } from "./RateLimitBanner";
import { EmptyState } from "./EmptyState";
import { PRTable } from "./PRTable";
import { useIsMobile } from "@/hooks/useMediaQuery";

interface DashboardProps {
  initialSessions: DashboardSession[];
  projectId?: string;
  projectName?: string;
  projects?: ProjectInfo[];
  initialGlobalPause?: GlobalPauseState | null;
  orchestrators?: DashboardOrchestratorLink[];
}

const KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;
const KANBAN_LABELS: Record<string, string> = {
  working: "Working", pending: "Pending", review: "Review", respond: "Respond", merge: "Merge",
};
const KANBAN_LABEL_COLORS: Record<string, string> = {
  working: "var(--color-status-working)", pending: "var(--color-status-attention)",
  review: "var(--color-accent-orange)", respond: "var(--color-status-error)",
  merge: "var(--color-status-ready)",
};
const EMPTY_ORCHESTRATORS: DashboardOrchestratorLink[] = [];

function mergeOrchestrators(
  current: DashboardOrchestratorLink[], incoming: DashboardOrchestratorLink[],
): DashboardOrchestratorLink[] {
  const merged = new Map(current.map((o) => [o.projectId, o]));
  for (const o of incoming) merged.set(o.projectId, o);
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
  const isMobile = useIsMobile();
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage("ao-sidebar-collapsed", false);
  const [sidebarWidth, setSidebarWidth] = useLocalStorage("ao-sidebar-width", 180);
  const [mobileForceCollapsed, setMobileForceCollapsed] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(max-width: 767px)").matches;
  });
  useEffect(() => {
    setMobileForceCollapsed(isMobile);
  }, [isMobile]);
  const effectiveSidebarCollapsed = isMobile ? mobileForceCollapsed : sidebarCollapsed;
  const noop = useCallback(() => {}, []);
  const setDesktopCollapsed = useCallback(
    (value: boolean) => { if (!window.matchMedia("(max-width: 767px)").matches) setSidebarCollapsed(value); },
    [setSidebarCollapsed],
  );
  const { sessions, globalPause } = useSessionEvents(initialSessions, initialGlobalPause, projectId);
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [dismissedPauseKey, setDismissedPauseKey] = useState<string | null>(null);
  const [activeOrchestrators, setActiveOrchestrators] =
    useState<DashboardOrchestratorLink[]>(orchestratorLinks);

  const {
    spawningProjectIds, spawnErrors,
    handleSend, handleKill, handleMerge, handleRestore, handleSpawnOrchestrator,
  } = useDashboardActions(setActiveOrchestrators);

  const allProjectsView = projects.length > 1 && projectId === undefined;
  const selectedProject = useMemo(() => {
    if (projectId) return projects.find((p) => p.id === projectId) ?? null;
    if (projects.length === 1) return projects[0];
    return null;
  }, [projectId, projects]);

  const selectedProjectOrchestrator = useMemo(() => {
    if (!selectedProject) return null;
    return activeOrchestrators.find((o) => o.projectId === selectedProject.id) ?? null;
  }, [activeOrchestrators, selectedProject]);

  useEffect(() => {
    setActiveOrchestrators((current) => mergeOrchestrators(current, orchestratorLinks));
  }, [orchestratorLinks]);

  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [], respond: [], review: [], pending: [], working: [], done: [],
    };
    for (const session of sessions) zones[getAttentionLevel(session)].push(session);
    return zones;
  }, [sessions]);

  const openPRs = useMemo(() => {
    return sessions
      .filter((s): s is DashboardSession & { pr: DashboardPR } => s.pr?.state === "open")
      .map((s) => s.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [sessions]);

  const projectOverviews = useMemo(() => {
    if (!allProjectsView) return [];
    return projects.map((project) => {
      const projectSessions = sessions.filter((s) => s.projectId === project.id);
      const counts: Record<AttentionLevel, number> = {
        merge: 0, respond: 0, review: 0, pending: 0, working: 0, done: 0,
      };
      for (const s of projectSessions) counts[getAttentionLevel(s)]++;
      return {
        project,
        orchestrator: activeOrchestrators.find((o) => o.projectId === project.id) ?? null,
        sessionCount: projectSessions.length,
        openPRCount: projectSessions.filter((s) => s.pr?.state === "open").length,
        counts,
      };
    });
  }, [activeOrchestrators, allProjectsView, projects, sessions]);

  const hasKanbanSessions = KANBAN_LEVELS.some((level) => grouped[level].length > 0);
  const anyRateLimited = useMemo(
    () => sessions.some((s) => s.pr && isPRRateLimited(s.pr)),
    [sessions],
  );

  const liveStats = useMemo<DashboardStats>(() => ({
    totalSessions: sessions.length,
    workingSessions: sessions.filter((s) => s.activity !== null && s.activity !== "exited").length,
    openPRs: sessions.filter((s) => s.pr?.state === "open").length,
    needsReview: sessions.filter((s) => s.pr && !s.pr.isDraft && s.pr.reviewDecision === "pending").length,
  }), [sessions]);

  const resumeAtLabel = useMemo(() => {
    if (!globalPause) return null;
    return new Date(globalPause.pausedUntil).toLocaleString();
  }, [globalPause]);

  const currentPauseKey = globalPause
    ? `${globalPause.pausedUntil}|${globalPause.reason}|${globalPause.sourceSessionId}`
    : null;
  const globalPauseDismissed = currentPauseKey !== null && currentPauseKey === dismissedPauseKey;

  return (
    <div className="flex h-screen">
      {!isMobile && !effectiveSidebarCollapsed && (
        <ProjectSidebar
          projects={projects}
          activeProjectId={projectId}
          orchestrators={activeOrchestrators}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setDesktopCollapsed}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
        />
      )}
      {isMobile && !mobileForceCollapsed && (
        <>
          <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setMobileForceCollapsed(true)} />
          <div className="fixed inset-y-0 left-0 z-40">
            <ProjectSidebar
              projects={projects}
              activeProjectId={projectId}
              orchestrators={activeOrchestrators}
              collapsed={false}
              onCollapsedChange={() => setMobileForceCollapsed(true)}
              width={260}
              onWidthChange={noop}
            />
          </div>
        </>
      )}
      <div className="flex-1 overflow-y-auto">
        <DynamicFavicon sessions={sessions} projectName={projectName} />
        <div className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] px-4 py-3 md:justify-between md:gap-6 md:px-8">
          <div className="flex flex-wrap items-center gap-3 md:gap-6">
            {effectiveSidebarCollapsed && (
              <button
                onClick={() => isMobile ? setMobileForceCollapsed(false) : setDesktopCollapsed(false)}
                aria-label="Expand sidebar"
                className="flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border-subtle)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-[var(--color-text-primary)]"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}
            <h1 className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--color-text-primary)] md:text-[17px]">
              {projectName ?? "Orchestrator"}
            </h1>
            <span className="hidden md:inline-flex"><StatusLine stats={liveStats} /></span>
          </div>
          {!allProjectsView && selectedProject && (
            <SpawnOrchestratorButton
              project={selectedProject}
              orchestrator={selectedProjectOrchestrator}
              onSpawnOrchestrator={handleSpawnOrchestrator}
              isSpawning={spawningProjectIds.includes(selectedProject.id)}
              error={spawnErrors[selectedProject.id]}
            />
          )}
        </div>

        <div className="px-4 py-5 md:px-8 md:py-7">
        {globalPause && !globalPauseDismissed && (
          <GlobalPauseBanner globalPause={globalPause} resumeAtLabel={resumeAtLabel} onDismiss={() => setDismissedPauseKey(currentPauseKey)} />
        )}
        {anyRateLimited && !rateLimitDismissed && (
          <RateLimitBanner onDismiss={() => setRateLimitDismissed(true)} />
        )}
        {allProjectsView && (
          <ProjectOverviewGrid overviews={projectOverviews} onSpawnOrchestrator={handleSpawnOrchestrator} spawningProjectIds={spawningProjectIds} spawnErrors={spawnErrors} />
        )}
        {!allProjectsView && hasKanbanSessions && (
          <div className="mb-8 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:snap-none md:gap-4">
            {KANBAN_LEVELS.map((level) => (
              <div key={level} className="min-w-[260px] flex-1 snap-start sm:min-w-[200px]">
                {grouped[level].length > 0 ? (
                  <AttentionZone level={level} sessions={grouped[level]} variant="column" onSend={handleSend} onKill={handleKill} onMerge={handleMerge} onRestore={handleRestore} />
                ) : (
                  <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-subtle)] px-3 py-4">
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.10em]" style={{ color: KANBAN_LABEL_COLORS[level] }}>{KANBAN_LABELS[level]}</div>
                    <p className="text-[11px] text-[var(--color-text-muted)]">No sessions</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {!allProjectsView && !hasKanbanSessions && sessions.length === 0 && selectedProject && (
          <div className="mb-8">
            <EmptyState
              icon={<svg className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M8 9l3 3-3 3M13 15h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>}
              message={selectedProjectOrchestrator ? "No sessions yet" : "Spawn orchestrator to get started"}
              description={selectedProjectOrchestrator ? "The orchestrator is running. Sessions will appear here as work begins." : "An orchestrator manages sessions for this project. Spawn one to begin."}
              action={!selectedProjectOrchestrator ? (
                <SpawnOrchestratorButton project={selectedProject} orchestrator={null} onSpawnOrchestrator={handleSpawnOrchestrator} isSpawning={spawningProjectIds.includes(selectedProject.id)} error={spawnErrors[selectedProject.id]} variant="default" />
              ) : undefined}
            />
          </div>
        )}
        {!allProjectsView && grouped.done.length > 0 && (
          <div className="mb-8">
            <AttentionZone level="done" sessions={grouped.done} variant="grid" onSend={handleSend} onKill={handleKill} onMerge={handleMerge} onRestore={handleRestore} />
          </div>
        )}
        <PRTable openPRs={openPRs} />
        </div>
      </div>
    </div>
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
