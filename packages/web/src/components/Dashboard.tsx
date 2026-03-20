"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { ProjectSidebar } from "./ProjectSidebar";
import type { ProjectInfo } from "@/lib/project-name";
import { StatusLine } from "./StatusLine";
import { ProjectOrchestratorControl } from "./ProjectOrchestratorControl";
import { ProjectOverviewGrid } from "./ProjectOverviewGrid";
import { GlobalPauseBanner } from "./GlobalPauseBanner";
import { RateLimitBanner } from "./RateLimitBanner";
import { EmptyState } from "./EmptyState";
import { SpawnOrchestratorButton } from "./SpawnOrchestratorButton";
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
  const hasAutoCollapsed = useRef(false);
  useEffect(() => {
    if (isMobile && !hasAutoCollapsed.current) {
      setSidebarCollapsed(true);
      hasAutoCollapsed.current = true;
    } else if (!isMobile) {
      hasAutoCollapsed.current = false;
    }
  }, [isMobile, setSidebarCollapsed]);
  const { sessions, globalPause } = useSessionEvents(
    initialSessions,
    initialGlobalPause,
    projectId,
  );
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [globalPauseDismissed, setGlobalPauseDismissed] = useState(false);
  const [activeOrchestrators, setActiveOrchestrators] =
    useState<DashboardOrchestratorLink[]>(orchestratorLinks);
  const [spawningProjectIds, setSpawningProjectIds] = useState<string[]>([]);
  const [spawnErrors, setSpawnErrors] = useState<Record<string, string>>({});
  const allProjectsView = projects.length > 1 && projectId === undefined;
  const selectedProject = useMemo(() => {
    if (projectId) {
      return projects.find((project) => project.id === projectId) ?? null;
    }
    if (projects.length === 1) {
      return projects[0];
    }
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
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of sessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [sessions]);

  const openPRs = useMemo(() => {
    return sessions
      .filter(
        (session): session is DashboardSession & { pr: DashboardPR } =>
          session.pr?.state === "open",
      )
      .map((session) => session.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [sessions]);

  const projectOverviews = useMemo(() => {
    if (!allProjectsView) return [];

    return projects.map((project) => {
      const projectSessions = sessions.filter((session) => session.projectId === project.id);
      const counts: Record<AttentionLevel, number> = {
        merge: 0,
        respond: 0,
        review: 0,
        pending: 0,
        working: 0,
        done: 0,
      };

      for (const session of projectSessions) {
        counts[getAttentionLevel(session)]++;
      }

      return {
        project,
        orchestrator:
          activeOrchestrators.find((orchestrator) => orchestrator.projectId === project.id) ?? null,
        sessionCount: projectSessions.length,
        openPRCount: projectSessions.filter((session) => session.pr?.state === "open").length,
        counts,
      };
    });
  }, [activeOrchestrators, allProjectsView, projects, sessions]);

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
    }
  };

  const handleKill = async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to kill ${sessionId}:`, await res.text());
    }
  };

  const handleMerge = async (prNumber: number) => {
    const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
    if (!res.ok) {
      console.error(`Failed to merge PR #${prNumber}:`, await res.text());
    }
  };

  const handleRestore = async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to restore ${sessionId}:`, await res.text());
    }
  };

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

  const hasKanbanSessions = KANBAN_LEVELS.some((level) => grouped[level].length > 0);

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
    <div className="flex h-screen">
      {/* Desktop sidebar — hidden on mobile via CSS, hidden when collapsed via JS */}
      {!sidebarCollapsed && (
        <div className="hidden md:block">
          <ProjectSidebar
            projects={projects}
            activeProjectId={projectId}
            orchestrators={activeOrchestrators}
            onSpawnOrchestrator={handleSpawnOrchestrator}
            spawningProjectIds={spawningProjectIds}
            collapsed={sidebarCollapsed}
            onCollapsedChange={setSidebarCollapsed}
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
          />
        </div>
      )}
      {/* Mobile sidebar — overlay, only rendered client-side when isMobile && expanded */}
      {isMobile && !sidebarCollapsed && (
        <>
          <div
            className="fixed inset-0 z-30 bg-black/50"
            onClick={() => setSidebarCollapsed(true)}
          />
          <div className="fixed inset-y-0 left-0 z-40">
            <ProjectSidebar
              projects={projects}
              activeProjectId={projectId}
              orchestrators={activeOrchestrators}
              onSpawnOrchestrator={handleSpawnOrchestrator}
              spawningProjectIds={spawningProjectIds}
              collapsed={sidebarCollapsed}
              onCollapsedChange={setSidebarCollapsed}
              width={260}
              onWidthChange={setSidebarWidth}
            />
          </div>
        </>
      )}
      <div className="flex-1 overflow-y-auto">
        <DynamicFavicon sessions={sessions} projectName={projectName} />
        <div className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] px-4 py-3 md:justify-between md:gap-6 md:px-8">
          <div className="flex flex-wrap items-center gap-3 md:gap-6">
            {sidebarCollapsed && (
              <button
                onClick={() => setSidebarCollapsed(false)}
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
            <ProjectOrchestratorControl
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
          <GlobalPauseBanner
            globalPause={globalPause}
            resumeAtLabel={resumeAtLabel}
            onDismiss={() => setGlobalPauseDismissed(true)}
          />
        )}

        {anyRateLimited && !rateLimitDismissed && (
          <RateLimitBanner onDismiss={() => setRateLimitDismissed(true)} />
        )}

        {allProjectsView && (
          <ProjectOverviewGrid
            overviews={projectOverviews}
            onSpawnOrchestrator={handleSpawnOrchestrator}
            spawningProjectIds={spawningProjectIds}
            spawnErrors={spawnErrors}
          />
        )}

        {!allProjectsView && hasKanbanSessions && (
          <div className="mb-8 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:snap-none md:gap-4">
            {KANBAN_LEVELS.map((level) =>
              grouped[level].length > 0 ? (
                <div key={level} className="min-w-[260px] flex-1 snap-start sm:min-w-[200px]">
                  <AttentionZone
                    level={level}
                    sessions={grouped[level]}
                    variant="column"
                    onSend={handleSend}
                    onKill={handleKill}
                    onMerge={handleMerge}
                    onRestore={handleRestore}
                  />
                </div>
              ) : null,
            )}
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
            <AttentionZone
              level="done"
              sessions={grouped.done}
              variant="grid"
              onSend={handleSend}
              onKill={handleKill}
              onMerge={handleMerge}
              onRestore={handleRestore}
            />
          </div>
        )}

        {openPRs.length > 0 && (
          <div className="mx-auto max-w-[900px]">
            <h2 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
              Pull Requests
            </h2>
            <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border-default)]">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border-muted)]">
                    {["PR", "Title", "Size", "CI", "Review", "Unresolved"].map((col) => (
                      <th key={col} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        {col}
                      </th>
                    ))}
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
