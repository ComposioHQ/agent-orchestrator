"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import {
  type DashboardSession,
  type DashboardStats,
  type AttentionLevel,
  type DashboardOrchestratorLink,
  getAttentionLevel,
  isPRRateLimited,
  isPRMergeReady,
} from "@/lib/types";
import { AttentionZone } from "./AttentionZone";
import { DynamicFavicon, countNeedingAttention } from "./DynamicFavicon";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { ProjectSidebar } from "./ProjectSidebar";
import { ThemeToggle } from "./ThemeToggle";
import type { ProjectInfo } from "@/lib/project-name";
import { EmptyState } from "./Skeleton";
import { ToastProvider, useToast } from "./Toast";
import { BottomSheet } from "./BottomSheet";
import { ConnectionBar } from "./ConnectionBar";
import { MobileBottomNav } from "./MobileBottomNav";
import { getProjectScopedHref } from "@/lib/project-utils";

interface DashboardProps {
  initialSessions: DashboardSession[];
  projectId?: string;
  projectName?: string;
  projects?: ProjectInfo[];
  orchestrators?: DashboardOrchestratorLink[];
}

const KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;
/** Urgency-first order for the mobile accordion (reversed from desktop) */
const MOBILE_KANBAN_ORDER = ["respond", "merge", "review", "pending", "working"] as const;
const MOBILE_FILTERS = [
  { value: "all", label: "All" },
  { value: "respond", label: "Respond" },
  { value: "merge", label: "Ready" },
  { value: "review", label: "Review" },
  { value: "pending", label: "Pending" },
  { value: "working", label: "Working" },
] as const;
type MobileAttentionLevel = (typeof MOBILE_KANBAN_ORDER)[number];
type MobileFilterValue = (typeof MOBILE_FILTERS)[number]["value"];
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

function DashboardInner({
  initialSessions,
  projectId,
  projectName,
  projects = [],
  orchestrators,
}: DashboardProps) {
  const orchestratorLinks = orchestrators ?? EMPTY_ORCHESTRATORS;
  const initialAttentionLevels = useMemo(() => {
    const levels: Record<string, AttentionLevel> = {};
    for (const s of initialSessions) {
      levels[s.id] = getAttentionLevel(s);
    }
    return levels;
  }, [initialSessions]);
  const { sessions, connectionStatus, sseAttentionLevels } = useSessionEvents(
    initialSessions,
    projectId,
    initialAttentionLevels,
  );
  const searchParams = useSearchParams();
  const activeSessionId = searchParams.get("session") ?? undefined;
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [activeOrchestrators, setActiveOrchestrators] =
    useState<DashboardOrchestratorLink[]>(orchestratorLinks);
  const [spawningProjectIds, setSpawningProjectIds] = useState<string[]>([]);
  const [spawnErrors, setSpawnErrors] = useState<Record<string, string>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [hasMounted, setHasMounted] = useState(false);
  const [expandedLevel, setExpandedLevel] = useState<MobileAttentionLevel | null>(null);
  const [mobileFilter, setMobileFilter] = useState<MobileFilterValue>("all");
  const showSidebar = projects.length > 1;
  const { showToast } = useToast();
  const [sheetState, setSheetState] = useState<{
    sessionId: string;
    mode: "preview" | "confirm-kill";
  } | null>(null);
  const [sheetSessionOverride, setSheetSessionOverride] = useState<DashboardSession | null>(null);
  const sessionsRef = useRef(sessions);
  const hasSeededMobileExpansionRef = useRef(false);
  sessionsRef.current = sessions;
  const allProjectsView = showSidebar && projectId === undefined;
  const currentProjectOrchestrator = useMemo(
    () =>
      projectId
        ? activeOrchestrators.find((orchestrator) => orchestrator.projectId === projectId) ?? null
        : null,
    [activeOrchestrators, projectId],
  );
  const dashboardHref = getProjectScopedHref("/", projectId);
  const prsHref = getProjectScopedHref("/prs", projectId);
  const orchestratorHref = currentProjectOrchestrator
    ? `/sessions/${encodeURIComponent(currentProjectOrchestrator.id)}`
    : null;

  const displaySessions = useMemo(() => {
    if (allProjectsView || !activeSessionId) return sessions;
    return sessions.filter((s) => s.id === activeSessionId);
  }, [sessions, allProjectsView, activeSessionId]);
  const sheetSession = useMemo(
    () => (sheetState ? sessions.find((session) => session.id === sheetState.sessionId) ?? null : null),
    [sessions, sheetState],
  );
  const hydratedSheetSession = useMemo(() => {
    if (!sheetSession) return null;
    if (!sheetSessionOverride) return sheetSession;
    return {
      ...sheetSession,
      ...sheetSessionOverride,
      status: sheetSession.status,
      activity: sheetSession.activity,
      lastActivityAt: sheetSession.lastActivityAt,
    };
  }, [sheetSession, sheetSessionOverride]);

  useEffect(() => {
    setActiveOrchestrators((current) => mergeOrchestrators(current, orchestratorLinks));
  }, [orchestratorLinks]);

  // Update document title with live attention counts from SSE
  useEffect(() => {
    const needsAttention = countNeedingAttention(sseAttentionLevels);
    const label = projectName ?? "ao";
    document.title = needsAttention > 0 ? `${label} (${needsAttention} need attention)` : label;
  }, [sseAttentionLevels, projectName]);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [searchParams]);

  useEffect(() => {
    if (sheetState && sheetSession === null) {
      setSheetState(null);
    }
  }, [sheetSession, sheetState]);

  useEffect(() => {
    if (!sheetState || sheetState.mode !== "confirm-kill" || !hydratedSheetSession) return;
    if (getAttentionLevel(hydratedSheetSession) !== "done") return;
    setSheetState(null);
  }, [hydratedSheetSession, sheetState]);

  useEffect(() => {
    if (!sheetState) {
      setSheetSessionOverride(null);
      return;
    }

    let cancelled = false;
    const sessionId = sheetState.sessionId;
    const refreshSession = async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
        if (!res.ok) return;
        const data = (await res.json()) as Partial<DashboardSession> | null;
        if (!data || data.id !== sessionId) return;
        if (!cancelled) setSheetSessionOverride(data as DashboardSession);
      } catch {
        // Ignore transient failures; SSE still keeps status/activity fresh.
      }
    };

    void refreshSession();
    const interval = setInterval(refreshSession, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sheetState]);

  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of displaySessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [displaySessions]);

  // Auto-expand the most urgent non-empty section when switching to mobile.
  // Intentionally seeded once per mobile mode change, not on every session update.
  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (!isMobile) {
      hasSeededMobileExpansionRef.current = false;
      return;
    }
    if (hasSeededMobileExpansionRef.current) return;

    hasSeededMobileExpansionRef.current = true;
    setExpandedLevel(
      MOBILE_KANBAN_ORDER.find((level) => grouped[level].length > 0) ?? null,
    );
  }, [grouped, isMobile]);

  useEffect(() => {
    if (!isMobile) return;
    if (mobileFilter !== "all") {
      setExpandedLevel(mobileFilter);
      return;
    }
    // Preserve an explicit all-collapsed state. Only auto-expand when a specific expanded
    // section becomes empty, so SSE regrouping does not override a deliberate user collapse.
    setExpandedLevel((current) => {
      if (current === null) return current;
      if (current !== null && grouped[current].length > 0) return current;
      return MOBILE_KANBAN_ORDER.find((level) => grouped[level].length > 0) ?? null;
    });
  }, [grouped, isMobile, mobileFilter]);

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

  const projectOverviews = useMemo(() => {
    if (!allProjectsView) return [];

    return projects.map((project) => {
      const projectSessions = sessionsByProject.get(project.id) ?? [];
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
  }, [activeOrchestrators, allProjectsView, projects, sessionsByProject]);

  const handleAccordionToggle = useCallback((level: AttentionLevel) => {
    if (level === "done") return;
    setExpandedLevel((current) => (current === level ? null : level));
  }, []);

  const handlePillTap = useCallback((level: AttentionLevel) => {
    if (level === "done") return;
    setMobileFilter(level);
    setExpandedLevel(level);
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? ("instant" as ScrollBehavior)
      : "smooth";
    document.getElementById("mobile-board")?.scrollIntoView({ behavior, block: "start" });
  }, []);

  const visibleMobileLevels =
    mobileFilter === "all" ? MOBILE_KANBAN_ORDER : MOBILE_KANBAN_ORDER.filter((level) => level === mobileFilter);
  const showDesktopPrsLink = hasMounted && !isMobile;

  const handleSend = useCallback(async (sessionId: string, message: string) => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        const text = await res.text();
        const messageText = text || "Unknown error";
        console.error(`Failed to send message to ${sessionId}:`, messageText);
        showToast(`Send failed: ${messageText}`, "error");
        const errorWithToast = new Error(messageText);
        (errorWithToast as Error & { toastShown?: boolean }).toastShown = true;
        throw errorWithToast;
      }
    } catch (error) {
      const toastShown =
        error instanceof Error &&
        "toastShown" in error &&
        (error as Error & { toastShown?: boolean }).toastShown;
      if (!toastShown) {
        console.error(`Network error sending message to ${sessionId}:`, error);
        showToast("Network error while sending message", "error");
      }
      throw error;
    }
  }, [showToast]);

  const killSession = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text();
        console.error(`Failed to kill ${sessionId}:`, text);
        showToast(`Terminate failed: ${text}`, "error");
      } else {
        showToast("Session terminated", "success");
      }
    } catch (error) {
      console.error(`Network error killing ${sessionId}:`, error);
      showToast("Network error while terminating session", "error");
    }
  }, [showToast]);

  const handleKill = useCallback((sessionId: string) => {
    const session = sessionsRef.current.find((s) => s.id === sessionId) ?? null;
    if (!session) return;
    if (!isMobile) {
      const confirmed = window.confirm("Terminate this session?");
      if (confirmed) {
        void killSession(session.id);
      }
      return;
    }
    setSheetState({ sessionId: session.id, mode: "confirm-kill" });
  }, [isMobile, killSession]);

  const handlePreview = useCallback((session: DashboardSession) => {
    setSheetState({ sessionId: session.id, mode: "preview" });
  }, []);

  const handleRequestKillFromPreview = useCallback(() => {
    setSheetState((current) =>
      current ? { sessionId: current.sessionId, mode: "confirm-kill" } : current,
    );
  }, []);

  const handleKillConfirm = useCallback(async () => {
    const session = hydratedSheetSession;
    setSheetState(null);
    if (!session) return;
    await killSession(session.id);
  }, [hydratedSheetSession, killSession]);

  const handleMerge = useCallback(async (prNumber: number) => {
    try {
      const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
      if (!res.ok) {
        const text = await res.text();
        console.error(`Failed to merge PR #${prNumber}:`, text);
        showToast(`Merge failed: ${text}`, "error");
        return;
      } else {
        showToast(`PR #${prNumber} merged`, "success");
        setSheetState(null);
      }
    } catch (error) {
      console.error(`Network error merging PR #${prNumber}:`, error);
      showToast("Network error while merging PR", "error");
    }
  }, [showToast]);

  const handleRestore = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text();
        console.error(`Failed to restore ${sessionId}:`, text);
        showToast(`Restore failed: ${text}`, "error");
      } else {
        showToast("Session restored", "success");
      }
    } catch (error) {
      console.error(`Network error restoring ${sessionId}:`, error);
      showToast("Network error while restoring session", "error");
    }
  }, [showToast]);

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

  const hasAnySessions = KANBAN_LEVELS.some(
    (level) => grouped[level].length > 0,
  );

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

  return (
    <>
    <ConnectionBar status={connectionStatus} />
    <div className="dashboard-shell flex h-screen">
      {showSidebar && (
        <ProjectSidebar
          projects={projects}
          sessions={sessions}
          activeProjectId={projectId}
          activeSessionId={activeSessionId}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
          mobileOpen={mobileMenuOpen}
          onMobileClose={() => setMobileMenuOpen(false)}
        />
      )}
      <div className="dashboard-main flex-1 overflow-y-auto px-4 py-4 md:px-7 md:py-6">
        <div id="mobile-dashboard-anchor" aria-hidden="true" />
        <DynamicFavicon sseAttentionLevels={sseAttentionLevels} projectName={projectName} />
        <section className="dashboard-hero mb-5">
          <div className="dashboard-hero__backdrop" />
          <div className="dashboard-hero__content">
            {showSidebar && (
              <button
                type="button"
                className="mobile-menu-toggle"
                onClick={() => setMobileMenuOpen(true)}
                aria-label="Open menu"
              >
                <svg
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  className="h-5 w-5"
                >
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            )}
            <div className="dashboard-hero__primary">
              <div className="dashboard-hero__heading">
                <div className="dashboard-hero__copy">
                  <h1 className="dashboard-title">
                    {projectName ?? "Orchestrator"}
                  </h1>
                  <p className="dashboard-subtitle">
                    Live sessions, review pressure, and merge readiness.
                  </p>
                </div>
              </div>
              {!isMobile ? <StatusCards stats={liveStats} /> : null}
            </div>

            <div className="dashboard-hero__meta">
              <div className="flex items-center gap-3">
                {showDesktopPrsLink ? (
                  <a
                    href={prsHref}
                    className="dashboard-prs-link orchestrator-btn flex items-center gap-2 px-4 py-2 text-[12px] font-semibold hover:no-underline"
                  >
                    <svg
                      className="h-3.5 w-3.5 opacity-75"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M4 6h16M4 12h16M4 18h10" />
                    </svg>
                    PRs
                  </a>
                ) : null}
                {!allProjectsView && !isMobile ? (
                  <OrchestratorControl orchestrators={activeOrchestrators} />
                ) : null}
                <ThemeToggle />
              </div>
            </div>
          </div>
        </section>

        {isMobile ? (
          <section className="mobile-priority-row" aria-label="Needs attention">
            <div className="mobile-priority-row__label">Needs attention</div>
            <MobileActionStrip
              grouped={grouped}
              onPillTap={handlePillTap}
            />
          </section>
        ) : null}

        {isMobile ? (
          <section className="mobile-filter-row" aria-label="Dashboard filters">
            {MOBILE_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className="mobile-filter-chip"
                data-active={mobileFilter === filter.value ? "true" : "false"}
                onClick={() => setMobileFilter(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </section>
        ) : null}

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
          <ProjectOverviewGrid
            overviews={projectOverviews}
            onSpawnOrchestrator={handleSpawnOrchestrator}
            spawningProjectIds={spawningProjectIds}
            spawnErrors={spawnErrors}
          />
        )}

        {!allProjectsView && hasAnySessions && (
          <div className="kanban-board-wrap">
            <div className="board-section-head">
              <div>
                <h2 className="board-section-head__title">Attention Board</h2>
                <p className="board-section-head__subtitle">
                  Triage by required intervention, not by chronology.
                </p>
              </div>
              <div className="board-section-head__legend">
                <BoardLegendItem label="Human action" tone="var(--color-status-error)" />
                <BoardLegendItem label="Review queue" tone="var(--color-accent-orange)" />
                <BoardLegendItem label="Ready to land" tone="var(--color-status-ready)" />
              </div>
            </div>

            {isMobile ? (
              <div id="mobile-board" className="accordion-board">
                {visibleMobileLevels.map((level) => (
                  <AttentionZone
                    key={level}
                    level={level}
                    sessions={grouped[level]}
                    onSend={handleSend}
                    onKill={handleKill}
                    onMerge={handleMerge}
                    onRestore={handleRestore}
                    collapsed={expandedLevel !== level}
                    onToggle={handleAccordionToggle}
                    compactMobile
                    onPreview={handlePreview}
                    resetKey={mobileFilter}
                  />
                ))}
              </div>
            ) : (
              <div className="kanban-board">
                {KANBAN_LEVELS.map((level) => (
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
            )}
          </div>
        )}

        {!allProjectsView && !hasAnySessions && <EmptyState />}

      </div>
    </div>
    {isMobile ? (
      <MobileBottomNav
        ariaLabel="Dashboard navigation"
        activeTab="dashboard"
        dashboardHref={dashboardHref}
        prsHref={prsHref}
        showOrchestrator={!allProjectsView}
        orchestratorHref={orchestratorHref}
      />
    ) : null}
    {isMobile ? (
    <BottomSheet
      session={hydratedSheetSession}
      mode={sheetState?.mode ?? "preview"}
      onConfirm={handleKillConfirm}
      onCancel={() => setSheetState(null)}
      onRequestKill={handleRequestKillFromPreview}
      onMerge={handleMerge}
      isMergeReady={
        hydratedSheetSession?.pr ? isPRMergeReady(hydratedSheetSession.pr) : false
      }
    />
    ) : null}
    </>
  );
}

export function Dashboard(props: DashboardProps) {
  return (
    <ToastProvider>
      <DashboardInner {...props} />
    </ToastProvider>
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
  overviews,
  onSpawnOrchestrator,
  spawningProjectIds,
  spawnErrors,
}: {
  overviews: Array<{
    project: ProjectInfo;
    orchestrator: DashboardOrchestratorLink | null;
    sessionCount: number;
    openPRCount: number;
    counts: Record<AttentionLevel, number>;
  }>;
  onSpawnOrchestrator: (project: ProjectInfo) => Promise<void>;
  spawningProjectIds: string[];
  spawnErrors: Record<string, string>;
}) {
  return (
    <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {overviews.map(({ project, orchestrator, sessionCount, openPRCount, counts }) => (
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

const MOBILE_ACTION_STRIP_LEVELS = [
  {
    level: "respond" as const,
    label: "respond",
    color: "var(--color-status-error)",
  },
  {
    level: "merge" as const,
    label: "merge",
    color: "var(--color-status-ready)",
  },
  {
    level: "review" as const,
    label: "review",
    color: "var(--color-accent-orange)",
  },
] satisfies Array<{ level: AttentionLevel; label: string; color: string }>;

function MobileActionStrip({
  grouped,
  onPillTap,
}: {
  grouped: Record<AttentionLevel, DashboardSession[]>;
  onPillTap: (level: AttentionLevel) => void;
}) {
  const activePills = MOBILE_ACTION_STRIP_LEVELS.filter(
    ({ level }) => grouped[level].length > 0,
  );

  if (activePills.length === 0) {
    return (
      <div role="status" className="mobile-action-strip mobile-action-strip--all-good">
        <span className="mobile-action-strip__all-good">All clear — agents are working</span>
      </div>
    );
  }

  return (
    <div className="mobile-action-strip" role="group" aria-label="Session priorities">
      {activePills.map(({ level, label, color }) => (
        <button
          key={level}
          type="button"
          className="mobile-action-pill"
          onClick={() => onPillTap(level)}
          aria-label={`${grouped[level].length} ${label} — scroll to section`}
        >
          <span
            className="mobile-action-pill__dot"
            style={{ background: color }}
            aria-hidden="true"
          />
          <span className="mobile-action-pill__count" style={{ color }}>
            {grouped[level].length}
          </span>
          <span className="mobile-action-pill__label">{label}</span>
        </button>
      ))}
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
