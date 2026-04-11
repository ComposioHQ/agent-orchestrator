"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import {
  type DashboardSession,
  type DashboardPR,
  type AttentionLevel,
  type DashboardOrchestratorLink,
  getAttentionLevel,
  isPRRateLimited,
  isPRMergeReady,
  isPRUnenriched,
} from "@/lib/types";
import { AttentionZone } from "./AttentionZone";
import { DynamicFavicon, countNeedingAttention } from "./DynamicFavicon";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { useMuxOptional } from "@/providers/MuxProvider";
import { ProjectSidebar } from "./ProjectSidebar";
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

type MobileFilterValue = (typeof MOBILE_FILTERS)[number]["value"];
const EMPTY_ORCHESTRATORS: DashboardOrchestratorLink[] = [];

function formatRelativeTimeCompact(isoDate: string | null): string {
  if (!isoDate) return "just now";
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return "just now";

  const diffMs = Date.now() - timestamp;
  if (diffMs <= 0) return "just now";

  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

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

function DoneCard({
  session,
  onRestore,
}: {
  session: DashboardSession;
  onRestore: (id: string) => void;
}) {
  const title =
    (!session.summaryIsFallback && session.summary) ||
    session.issueTitle ||
    session.summary ||
    session.id;
  const isMerged = session.pr?.state === "merged";
  const isTerminated = session.status === "killed" || session.status === "terminated";
  const badgeLabel = isMerged ? "merged" : isTerminated ? "terminated" : "done";
  const badgeClass = `done-card__badge ${isTerminated ? "done-card__badge--terminated" : "done-card__badge--merged"}`;

  return (
    <div className="done-card">
      <p className="done-card__title">{title}</p>
      <div className="done-card__meta">
        <span className={badgeClass}>{badgeLabel}</span>
        {session.pr ? (
          <a
            href={session.pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="done-card__pr"
            onClick={(e) => e.stopPropagation()}
          >
            <svg width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <path d="M6 9v3a6 6 0 0 0 6 6h3" />
            </svg>
            #{session.pr.number}
          </a>
        ) : null}
        <span className="done-card__age">{formatRelativeTimeCompact(session.lastActivityAt)}</span>
        <button
          type="button"
          className="done-card__restore"
          onClick={(e) => {
            e.stopPropagation();
            onRestore(session.id);
          }}
        >
          Restore
        </button>
      </div>
    </div>
  );
}

function getCiPillClass(pr: DashboardPR): string {
  if (isPRRateLimited(pr) || isPRUnenriched(pr)) return "";
  return pr.ciStatus === "passing"
    ? "mobile-feed-card__pill--green"
    : pr.ciStatus === "failing"
      ? "mobile-feed-card__pill--red"
      : "mobile-feed-card__pill--amber";
}

function getCiLabel(pr: DashboardPR): string {
  if (isPRRateLimited(pr) || isPRUnenriched(pr)) return "";
  return pr.ciStatus === "passing" ? "CI passing" : pr.ciStatus === "failing" ? "CI failed" : "CI pending";
}

function getReviewPillClass(pr: DashboardPR): string {
  if (isPRRateLimited(pr) || isPRUnenriched(pr)) return "";
  return pr.reviewDecision === "approved"
    ? "mobile-feed-card__pill--green"
    : pr.reviewDecision === "changes_requested"
      ? "mobile-feed-card__pill--red"
      : "mobile-feed-card__pill--amber";
}

function getReviewLabel(pr: DashboardPR): string {
  if (isPRRateLimited(pr) || isPRUnenriched(pr)) return "";
  return pr.reviewDecision === "approved"
    ? "approved"
    : pr.reviewDecision === "changes_requested"
      ? "changes requested"
      : "needs review";
}

function MobileFeedCard({
  session,
  level,
  onTap,
}: {
  session: DashboardSession;
  level: AttentionLevel;
  onTap: (session: DashboardSession) => void;
}) {
  const title =
    (!session.summaryIsFallback && session.summary) ||
    session.issueTitle ||
    session.summary ||
    session.id;
  const pr = session.pr;

  return (
    <button
      type="button"
      className="mobile-feed-card"
      onClick={() => onTap(session)}
    >
      <div className="mobile-feed-card__strip" data-level={level} />
      <div className="mobile-feed-card__content">
        <div className="mobile-feed-card__header">
          <span className="mobile-feed-card__id">{session.id}</span>
          <span className="mobile-feed-card__time">
            {formatRelativeTimeCompact(session.lastActivityAt)}
          </span>
        </div>
        <div className="mobile-feed-card__title">{title}</div>
        <div className="mobile-feed-card__meta">
          {session.branch ? (
            <span className="mobile-feed-card__branch">{session.branch}</span>
          ) : null}
          {pr ? (
            <span className="mobile-feed-card__pr">#{pr.number}</span>
          ) : null}
          {pr && !isPRRateLimited(pr) && !isPRUnenriched(pr) ? (
            <span className="mobile-feed-card__diff">
              <span style={{ color: "var(--color-accent-green)" }}>+{pr.additions}</span>
              {" "}
              <span style={{ color: "var(--color-accent-red)" }}>-{pr.deletions}</span>
            </span>
          ) : null}
        </div>
        {pr && !isPRRateLimited(pr) && !isPRUnenriched(pr) ? (
          <div className="mobile-feed-card__pills">
            {getCiLabel(pr) ? (
              <span className={`mobile-feed-card__pill ${getCiPillClass(pr)}`}>
                {getCiLabel(pr)}
              </span>
            ) : null}
            {getReviewLabel(pr) ? (
              <span className={`mobile-feed-card__pill ${getReviewPillClass(pr)}`}>
                {getReviewLabel(pr)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </button>
  );
}

function DashboardInner({
  initialSessions,
  projectId,
  projectName,
  projects = [],
  orchestrators,
}: DashboardProps) {
  const orchestratorLinks = orchestrators ?? EMPTY_ORCHESTRATORS;
  const mux = useMuxOptional();
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
    mux?.status === "connected" ? mux.sessions : undefined,
    initialAttentionLevels,
    false,
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
  const [mobileFilter, setMobileFilter] = useState<MobileFilterValue>("all");
  const showSidebar = projects.length >= 1;
  const { showToast } = useToast();
  const [sheetState, setSheetState] = useState<{
    sessionId: string;
    mode: "preview" | "confirm-kill";
  } | null>(null);
  const [sheetSessionOverride, setSheetSessionOverride] = useState<DashboardSession | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const sessionsRef = useRef(sessions);

  sessionsRef.current = sessions;
  const allProjectsView = projects.length > 1 && showSidebar && projectId === undefined;
  const currentProjectOrchestrator = useMemo(
    () =>
      projectId
        ? (activeOrchestrators.find((orchestrator) => orchestrator.projectId === projectId) ?? null)
        : null,
    [activeOrchestrators, projectId],
  );
  const dashboardHref = getProjectScopedHref("/", projectId);
  const prsHref = getProjectScopedHref("/prs", projectId);
  const orchestratorHref = currentProjectOrchestrator
    ? `/sessions/${encodeURIComponent(currentProjectOrchestrator.id)}`
    : null;
  const latestActivityAt = useMemo(() => {
    if (sessions.length === 0) return null;

    let latest: string | null = null;
    let latestTs = -Infinity;

    for (const session of sessions) {
      const ts = new Date(session.lastActivityAt).getTime();
      if (!Number.isFinite(ts) || ts <= latestTs) continue;
      latestTs = ts;
      latest = session.lastActivityAt;
    }

    return latest;
  }, [sessions]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const headerMeta = useMemo(() => {
    const sessionLabel = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
    if (!mounted) return sessionLabel;
    return `${sessionLabel} · ${formatRelativeTimeCompact(latestActivityAt)}`;
  }, [latestActivityAt, sessions.length, mounted]);

  const displaySessions = useMemo(() => {
    if (allProjectsView || !activeSessionId) return sessions;
    return sessions.filter((s) => s.id === activeSessionId);
  }, [sessions, allProjectsView, activeSessionId]);
  const sheetSession = useMemo(
    () =>
      sheetState ? (sessions.find((session) => session.id === sheetState.sessionId) ?? null) : null,
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

  const handlePillTap = useCallback((level: AttentionLevel) => {
    if (level === "done") return;
    setMobileFilter(level);
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? ("instant" as ScrollBehavior)
      : "smooth";
    document.getElementById("mobile-board")?.scrollIntoView({ behavior, block: "start" });
  }, []);

  const mobileFeedSessions = useMemo(() => {
    const levels = mobileFilter === "all"
      ? MOBILE_KANBAN_ORDER
      : MOBILE_KANBAN_ORDER.filter((level) => level === mobileFilter);
    const feed: Array<{ session: DashboardSession; level: AttentionLevel }> = [];
    for (const level of levels) {
      for (const session of grouped[level]) {
        feed.push({ session, level });
      }
    }
    return feed;
  }, [grouped, mobileFilter]);

  const showDesktopPrsLink = hasMounted && !isMobile;

  const handleSend = useCallback(
    async (sessionId: string, message: string) => {
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
    },
    [showToast],
  );

  const killSession = useCallback(
    async (sessionId: string) => {
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
    },
    [showToast],
  );

  const handleKill = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId) ?? null;
      if (!session) return;
      if (!isMobile) {
        void killSession(session.id);
        return;
      }
      setSheetState({ sessionId: session.id, mode: "confirm-kill" });
    },
    [isMobile, killSession],
  );

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

  const handleMerge = useCallback(
    async (prNumber: number) => {
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
    },
    [showToast],
  );

  const handleRestore = useCallback(
    async (sessionId: string) => {
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
    },
    [showToast],
  );

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

  const hasAnySessions = KANBAN_LEVELS.some((level) => grouped[level].length > 0);
  const showEmptyState = !allProjectsView && !hasAnySessions;

  const anyRateLimited = useMemo(
    () => sessions.some((session) => session.pr && isPRRateLimited(session.pr)),
    [sessions],
  );
  const normalizedProjectName = projectName?.trim().toLowerCase();
  const headerProjectLabel =
    normalizedProjectName === "agent orchestrator"
      ? (projectId ?? projectName ?? (allProjectsView ? "All projects" : "Dashboard"))
      : (projectName ?? (allProjectsView ? "All projects" : "Dashboard"));
  const showHeaderProjectLabel = !allProjectsView && headerProjectLabel.trim().length > 0;

  if (!isMobile) {
    return (
      <>
        <ConnectionBar status={connectionStatus} />
        <div className="dashboard-app-shell">
          <header className="dashboard-app-header">
            {showSidebar ? (
              <button
                type="button"
                className="dashboard-app-sidebar-toggle"
                onClick={() => setSidebarCollapsed((current) => !current)}
                aria-label="Toggle sidebar"
              >
                <svg
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M9 3v18" />
                </svg>
              </button>
            ) : null}
            <div className="dashboard-app-header__brand">
              <span className="dashboard-app-header__brand-dot" aria-hidden="true" />
              <span>Agent Orchestrator</span>
            </div>
            {showHeaderProjectLabel ? (
              <>
                <span className="dashboard-app-header__sep" aria-hidden="true" />
                <span className="dashboard-app-header__project">{headerProjectLabel}</span>
              </>
            ) : null}
            <div className="dashboard-app-header__spacer" />
            <div className="dashboard-app-header__actions">
              {!allProjectsView && orchestratorHref ? (
                <a
                  href={orchestratorHref}
                  className="dashboard-app-btn dashboard-app-btn--amber"
                  aria-label="Orchestrator"
                >
                  <svg
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="5" r="2" fill="currentColor" stroke="none" />
                    <path d="M12 7v4M12 11H6M12 11h6M6 11v3M12 11v3M18 11v3" />
                    <circle cx="6" cy="17" r="2" />
                    <circle cx="12" cy="17" r="2" />
                    <circle cx="18" cy="17" r="2" />
                  </svg>
                  Orchestrator
                </a>
              ) : null}
            </div>
          </header>

          <div
            className={`dashboard-shell dashboard-shell--desktop${sidebarCollapsed ? " dashboard-shell--sidebar-collapsed" : ""}`}
          >
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

            <main className="dashboard-main dashboard-main--desktop">
              <DynamicFavicon sseAttentionLevels={sseAttentionLevels} projectName={projectName} />
              <div className="dashboard-main__subhead">
                <h1 className="dashboard-main__title">Dashboard</h1>
                <p className="dashboard-main__subtitle">
                  Live agent sessions, pull requests, and merge status.
                </p>
              </div>

              <div className="dashboard-main__body">
                {anyRateLimited && !rateLimitDismissed && (
                  <div className="dashboard-alert mb-4 flex items-center gap-2.5 border border-[color-mix(in_srgb,var(--color-status-attention)_25%,transparent)] bg-[var(--color-tint-yellow)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
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
                      GitHub API rate limited — PR data (CI status, review state, sizes) may be
                      stale. Will retry automatically on next refresh.
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
                  </div>
                )}

                {showEmptyState ? <EmptyState orchestratorHref={orchestratorHref} /> : null}

                {!allProjectsView && grouped.done.length > 0 && (
                  <div className="done-bar mt-6">
                    <button
                      type="button"
                      className="done-bar__toggle"
                      onClick={() => setDoneExpanded((v) => !v)}
                      aria-expanded={doneExpanded}
                    >
                      <svg
                        className={`done-bar__chevron${doneExpanded ? " done-bar__chevron--open" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                      <span className="done-bar__label">Done / Terminated</span>
                      <span className="done-bar__count">{grouped.done.length}</span>
                    </button>
                    {doneExpanded && (
                      <div className="done-bar__cards">
                        {grouped.done.map((session) => (
                          <DoneCard key={session.id} session={session} onRestore={handleRestore} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </main>
          </div>
        </div>
      </>
    );
  }

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
        <div className="dashboard-main flex-1 overflow-y-auto">
          <div id="mobile-dashboard-anchor" aria-hidden="true" />
          <DynamicFavicon sseAttentionLevels={sseAttentionLevels} projectName={projectName} />
          <section className="dashboard-hero">
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
                    <h1 className="dashboard-title">Kanban</h1>
                    {projectName ? <p className="dashboard-subtitle">{projectName}</p> : null}
                  </div>
                </div>
              </div>

              <div className="dashboard-hero__meta">
                <div className="dashboard-topbar-meta">
                  <span className="dashboard-topbar-summary">{headerMeta}</span>
                  {showDesktopPrsLink ? (
                    <a href={prsHref} className="dashboard-topbar-link dashboard-prs-link">
                      PRs
                    </a>
                  ) : null}
                  {!allProjectsView && !isMobile && orchestratorHref ? (
                    <a
                      href={orchestratorHref}
                      className="dashboard-topbar-link dashboard-topbar-link--orchestrator"
                      aria-label="Orchestrator"
                    >
                      <span className="dashboard-topbar-link__chip" aria-hidden="true">
                        Main
                      </span>
                      <span className="dashboard-topbar-link__label">Orchestrator</span>
                      <span className="dashboard-topbar-link__arrow" aria-hidden="true">
                        &rarr;
                      </span>
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <div className="px-4 pt-4 md:px-7 md:pt-6">
            {isMobile ? (
              <section className="mobile-priority-row" aria-label="Needs attention">
                <div className="mobile-priority-row__label">Needs attention</div>
                <MobileActionStrip grouped={grouped} onPillTap={handlePillTap} />
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
                  GitHub API rate limited — PR data (CI status, review state, sizes) may be stale.
                  Will retry automatically on next refresh.
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
                {isMobile ? (
                  <div id="mobile-board" className="mobile-feed">
                    {mobileFeedSessions.length > 0 ? (
                      mobileFeedSessions.map(({ session, level }) => (
                        <MobileFeedCard
                          key={session.id}
                          session={session}
                          level={level}
                          onTap={handlePreview}
                        />
                      ))
                    ) : (
                      <div className="mobile-feed-empty">No sessions match this filter.</div>
                    )}
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

            {!allProjectsView && !hasAnySessions && (
              <EmptyState orchestratorHref={orchestratorHref} />
            )}

            {!allProjectsView && grouped.done.length > 0 && (
              <div className="done-bar mt-6">
                <button
                  type="button"
                  className="done-bar__toggle"
                  onClick={() => setDoneExpanded((v) => !v)}
                  aria-expanded={doneExpanded}
                >
                  <svg
                    className={`done-bar__chevron${doneExpanded ? " done-bar__chevron--open" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                  <span className="done-bar__label">Done / Terminated</span>
                  <span className="done-bar__count">{grouped.done.length}</span>
                </button>
                {doneExpanded && (
                  <div className="done-bar__cards">
                    {grouped.done.map((session) => (
                      <DoneCard key={session.id} session={session} onRestore={handleRestore} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
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
          isMergeReady={hydratedSheetSession?.pr ? isPRMergeReady(hydratedSheetSession.pr) : false}
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
            <ProjectMetric label="Merge" value={counts.merge} tone="ready" />
            <ProjectMetric label="Respond" value={counts.respond} tone="error" />
            <ProjectMetric label="Review" value={counts.review} tone="orange" />
            <ProjectMetric label="Pending" value={counts.pending} tone="attention" />
            <ProjectMetric label="Working" value={counts.working} tone="working" />
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
      <div
        className="project-metric__value mt-1 text-[18px] font-semibold tabular-nums"
        data-tone={tone}
      >
        {value}
      </div>
    </div>
  );
}

const MOBILE_ACTION_STRIP_LEVELS = [
  { level: "respond" as const, label: "respond" },
  { level: "merge" as const, label: "merge" },
  { level: "review" as const, label: "review" },
] satisfies Array<{ level: AttentionLevel; label: string }>;

function MobileActionStrip({
  grouped,
  onPillTap,
}: {
  grouped: Record<AttentionLevel, DashboardSession[]>;
  onPillTap: (level: AttentionLevel) => void;
}) {
  const activePills = MOBILE_ACTION_STRIP_LEVELS.filter(({ level }) => grouped[level].length > 0);

  if (activePills.length === 0) {
    return (
      <div role="status" className="mobile-action-strip mobile-action-strip--all-good">
        <span className="mobile-action-strip__all-good">All clear — agents are working</span>
      </div>
    );
  }

  return (
    <div className="mobile-action-strip" role="group" aria-label="Session priorities">
      {activePills.map(({ level, label }) => (
        <button
          key={level}
          type="button"
          className="mobile-action-pill"
          onClick={() => onPillTap(level)}
          aria-label={`${grouped[level].length} ${label} — scroll to section`}
        >
          <span className="mobile-action-pill__dot" data-level={level} aria-hidden="true" />
          <span className="mobile-action-pill__count" data-level={level}>
            {grouped[level].length}
          </span>
          <span className="mobile-action-pill__label">{label}</span>
        </button>
      ))}
    </div>
  );
}
