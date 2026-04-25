"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import {
  type DashboardSession,
  type DashboardPR,
  TERMINAL_STATUSES,
  NON_RESTORABLE_STATUSES,
  isPRMergeReady,
  isPRRateLimited,
  isPRUnenriched,
} from "@/lib/types";
import { CI_STATUS } from "@aoagents/ao-core/types";
import { cn } from "@/lib/cn";
import dynamic from "next/dynamic";
import { formatRelativeTime, getSessionTitle } from "@/lib/format";
import { buildGitHubCompareUrl } from "@/lib/github-links";
import type { ProjectInfo } from "@/lib/project-name";
import { SidebarContext } from "./workspace/SidebarContext";
import { projectDashboardPath, projectSessionPath } from "@/lib/routes";

import { ProjectSidebar } from "./ProjectSidebar";
import { MobileBottomNav } from "./MobileBottomNav";

const DirectTerminal = dynamic(
  () => import("./DirectTerminal").then((m) => ({ default: m.DirectTerminal })),
  {
    ssr: false,
    // h-full (not a fixed 440px) so the skeleton matches the eventual terminal's
    // flex-1 sizing and the layout stays viewport-driven during lazy load.
    loading: () => (
      <div className="h-full w-full animate-pulse rounded bg-[var(--color-bg-primary)]" />
    ),
  },
);

interface OrchestratorZones {
  merge: number;
  respond: number;
  review: number;
  pending: number;
  working: number;
  done: number;
}

interface SessionDetailProps {
  session: DashboardSession;
  isOrchestrator?: boolean;
  orchestratorZones?: OrchestratorZones;
  projectOrchestratorId?: string | null;
  projects?: ProjectInfo[];
  sidebarSessions?: DashboardSession[] | null;
  sidebarLoading?: boolean;
  sidebarError?: boolean;
  onRetrySidebar?: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────

const activityMeta: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--color-status-working)" },
  ready: { label: "Ready", color: "var(--color-status-ready)" },
  idle: { label: "Idle", color: "var(--color-status-idle)" },
  waiting_input: { label: "Waiting for input", color: "var(--color-status-attention)" },
  blocked: { label: "Blocked", color: "var(--color-status-error)" },
  exited: { label: "Exited", color: "var(--color-status-error)" },
};

function cleanBugbotComment(body: string): { title: string; description: string } {
  const isBugbot = body.includes("<!-- DESCRIPTION START -->") || body.includes("### ");
  if (isBugbot) {
    const titleMatch = body.match(/###\s+(.+?)(?:\n|$)/);
    const title = titleMatch ? titleMatch[1].replace(/\*\*/g, "").trim() : "Comment";
    const descMatch = body.match(
      /<!-- DESCRIPTION START -->\s*([\s\S]*?)\s*<!-- DESCRIPTION END -->/,
    );
    const description = descMatch ? descMatch[1].trim() : body.split("\n")[0] || "No description";
    return { title, description };
  }
  return { title: "Comment", description: body.trim() };
}

function buildGitHubBranchUrl(pr: DashboardPR): string {
  return `https://github.com/${pr.owner}/${pr.repo}/tree/${pr.branch}`;
}

function normalizeActivityLabelForClass(activityLabel: string): string {
  return activityLabel.toLowerCase().replace(/\s+/g, "-");
}

function formatEndedTime(isoDate: string | null | undefined): string {
  if (!isoDate) return "Unknown";
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";
  return formatRelativeTime(timestamp);
}

function getEndedSessionReason(session: DashboardSession): string {
  if (session.lifecycle?.runtime.reasonLabel) {
    return session.lifecycle.runtime.reasonLabel;
  }
  if (session.status === "killed") return "Manually stopped";
  if (session.status === "terminated") return "Runtime unavailable";
  if (session.status === "done" || session.status === "merged") return "Work completed";
  return "Terminal ended";
}

function getEndedSessionSummary(session: DashboardSession, headline: string): string {
  const pinnedSummary = session.metadata["pinnedSummary"];
  if (pinnedSummary) return pinnedSummary;
  if (session.summary && !session.summaryIsFallback) return session.summary;
  if (session.lifecycle?.summary) return session.lifecycle.summary;
  if (session.userPrompt) return session.userPrompt;
  if (session.summary) return session.summary;
  return headline;
}

function SessionEndedSummary({
  session,
  headline,
  pr,
  dashboardHref,
}: {
  session: DashboardSession;
  headline: string;
  pr: DashboardPR | null;
  dashboardHref: string;
}) {
  const reason = getEndedSessionReason(session);
  const summary = getEndedSessionSummary(session, headline);
  const endedAt =
    session.lifecycle?.session.terminatedAt ??
    session.lifecycle?.session.completedAt ??
    session.lifecycle?.session.lastTransitionAt ??
    session.lastActivityAt;
  const runtimeLabel = session.lifecycle?.runtime.label ?? "Unavailable";
  const prLabel = pr
    ? pr.state === "merged"
      ? "Merged"
      : pr.state === "closed"
        ? "Closed"
        : pr.mergeability.mergeable
          ? "Open, merge-ready"
          : "Open"
    : "No PR";

  return (
    <section className="session-ended-summary" aria-label="Session ended summary">
      <div className="session-ended-summary__panel">
        <div className="session-ended-summary__eyebrow">Terminal ended</div>
        <div className="session-ended-summary__header">
          <div className="session-ended-summary__icon" aria-hidden="true">
            <svg fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <rect x="3" y="5" width="18" height="14" rx="3" />
              <path d="M7 10l3 2-3 2" />
              <path d="M13 15h4" />
            </svg>
          </div>
          <div className="session-ended-summary__title-group">
            <h2 className="session-ended-summary__title">{headline}</h2>
            <p className="session-ended-summary__subtitle">
              {reason}. The live terminal is gone, but the session context is still available.
            </p>
          </div>
        </div>

        <div className="session-ended-summary__body">
          <div className="session-ended-summary__section">
            <div className="session-ended-summary__label">What happened</div>
            <p className="session-ended-summary__copy">{summary}</p>
          </div>

          <div className="session-ended-summary__facts" aria-label="Session facts">
            <div className="session-ended-summary__fact">
              <span>Session</span>
              <strong>{session.id}</strong>
            </div>
            <div className="session-ended-summary__fact">
              <span>Ended</span>
              <strong>{formatEndedTime(endedAt)}</strong>
            </div>
            <div className="session-ended-summary__fact">
              <span>Runtime</span>
              <strong>{runtimeLabel}</strong>
            </div>
            <div className="session-ended-summary__fact">
              <span>PR</span>
              <strong>{prLabel}</strong>
            </div>
          </div>

          <div className="session-ended-summary__links">
            {pr ? (
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="session-ended-summary__primary"
              >
                Open PR #{pr.number}
              </a>
            ) : null}
            <a href={dashboardHref} className="session-ended-summary__secondary">
              Back to dashboard
            </a>
          </div>

          {session.lifecycle?.evidence ? (
            <div className="session-ended-summary__evidence">
              <span>Evidence</span>
              <code>{session.lifecycle.evidence}</code>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function OrchestratorZonePills({ zones }: { zones: OrchestratorZones }) {
  const stats: Array<{ value: number; label: string; toneClass: string }> = [
    { value: zones.merge, label: "merge", toneClass: "topbar-zone-pill--merge" },
    { value: zones.respond, label: "respond", toneClass: "topbar-zone-pill--respond" },
    { value: zones.review, label: "review", toneClass: "topbar-zone-pill--review" },
    { value: zones.working, label: "working", toneClass: "topbar-zone-pill--working" },
    { value: zones.pending, label: "pending", toneClass: "topbar-zone-pill--pending" },
    { value: zones.done, label: "done", toneClass: "topbar-zone-pill--done" },
  ].filter((stat) => stat.value > 0);

  if (stats.length === 0) return null;

  return (
    <>
      {stats.map((stat) => (
        <span key={stat.label} className={cn("topbar-zone-pill", stat.toneClass)}>
          <span className="topbar-zone-pill__value">{stat.value}</span>
          <span className="topbar-zone-pill__label">{stat.label}</span>
        </span>
      ))}
    </>
  );
}

async function askAgentToFix(
  sessionId: string,
  comment: { url: string; path: string; body: string },
  onSuccess: () => void,
  onError: () => void,
) {
  try {
    const { title, description } = cleanBugbotComment(comment.body);
    const message = `Please address this review comment:\n\nFile: ${comment.path}\nComment: ${title}\nDescription: ${description}\n\nComment URL: ${comment.url}\n\nAfter fixing, mark the comment as resolved at ${comment.url}`;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    onSuccess();
  } catch (err) {
    console.error("Failed to send message to agent:", err);
    onError();
  }
}

// ── Main component ────────────────────────────────────────────────────

export function SessionDetail({
  session,
  isOrchestrator = false,
  orchestratorZones,
  projectOrchestratorId = null,
  projects = [],
  sidebarSessions = [],
  sidebarLoading = false,
  sidebarError = false,
  onRetrySidebar,
}: SessionDetailProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const pr = session.pr;
  const terminalEnded = TERMINAL_STATUSES.has(session.status);
  const isRestorable = terminalEnded && !NON_RESTORABLE_STATUSES.has(session.status);
  const activity = (session.activity && activityMeta[session.activity]) ?? {
    label: session.activity ?? "unknown",
    color: "var(--color-text-muted)",
  };
  const headline = getSessionTitle(session);

  const terminalVariant = isOrchestrator ? "orchestrator" : "agent";

  const isOpenCodeSession = session.metadata["agent"] === "opencode";
  const opencodeSessionId =
    typeof session.metadata["opencodeSessionId"] === "string" &&
    session.metadata["opencodeSessionId"].length > 0
      ? session.metadata["opencodeSessionId"]
      : undefined;
  const reloadCommand = opencodeSessionId
    ? `/exit\nopencode --session ${opencodeSessionId}\n`
    : undefined;
  const dashboardHref = session.projectId ? projectDashboardPath(session.projectId) : "/";

  const handleKill = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/kill`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (projectOrchestratorId) {
        router.push(projectSessionPath(session.projectId, projectOrchestratorId));
        return;
      }
      router.push(dashboardHref);
    } catch (err) {
      console.error("Failed to kill session:", err);
    }
  }, [dashboardHref, projectOrchestratorId, router, session.id, session.projectId]);

  const handleRestore = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/restore`, {
        method: "POST",
      });
      if (!res.ok) {
        const message = await res.text().catch(() => "");
        throw new Error(message || `HTTP ${res.status}`);
      }
      window.location.reload();
    } catch (err) {
      console.error("Failed to restore session:", err);
    }
  }, [session.id]);

  const allGreen = pr ? isPRMergeReady(pr) : false;
  const [prPopoverOpen, setPrPopoverOpen] = useState(false);
  const prPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!prPopoverOpen) return;
    const handler = (e: MouseEvent) => {
      if (prPopoverRef.current && !prPopoverRef.current.contains(e.target as Node)) {
        setPrPopoverOpen(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPrPopoverOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [prPopoverOpen]);

  const headerProjectLabel =
    projects.find((project) => project.id === session.projectId)?.name ?? session.projectId;
  const showHeaderProjectLabel = headerProjectLabel.trim().toLowerCase() !== "agent orchestrator";
  const orchestratorHref = useMemo(() => {
    if (isOrchestrator) return projectSessionPath(session.projectId, session.id);
    if (projectOrchestratorId) return projectSessionPath(session.projectId, projectOrchestratorId);
    return null;
  }, [isOrchestrator, projectOrchestratorId, session.id, session.projectId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setShowTerminal(true));
    return () => {
      window.cancelAnimationFrame(frame);
      setShowTerminal(false);
    };
  }, [session.id]);

  const handleToggleSidebar = useCallback(() => {
    if (isMobile) {
      setMobileSidebarOpen((v) => !v);
    } else {
      setSidebarCollapsed((v) => !v);
    }
  }, [isMobile]);

  return (
    <SidebarContext.Provider value={{ onToggleSidebar: handleToggleSidebar, mobileSidebarOpen }}>
      <div className="dashboard-app-shell">
        <header className="dashboard-app-header">
          {projects.length > 0 ? (
            <button
              type="button"
              className="dashboard-app-sidebar-toggle"
              onClick={handleToggleSidebar}
              aria-label="Toggle sidebar"
            >
              {isMobile ? (
                <svg
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              ) : (
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
              )}
            </button>
          ) : null}
          <div className="dashboard-app-header__brand dashboard-app-header__brand--hide-mobile">
            <span>Agent Orchestrator</span>
          </div>
          {/* Desktop sep (hidden on mobile since brand is hidden) */}
          {showHeaderProjectLabel && (
            <span className="dashboard-app-header__sep topbar-desktop-only" aria-hidden="true" />
          )}
          {/* Project name + pills: stacked column on mobile, inline on desktop.
            On mobile the project name + session id share line 1 (so ao-N stays
            visually bound to the project), pills stack below on line 2. */}
          <div className="topbar-project-pills-group">
            <div className="topbar-project-line">
              {showHeaderProjectLabel && (
                <span className="dashboard-app-header__project">{headerProjectLabel}</span>
              )}
              <span className="dashboard-app-header__session-id topbar-mobile-only">
                {session.id}
              </span>
              {isOrchestrator && (
                <span className="session-detail-mode-badge">orchestrator</span>
              )}
            </div>
            <div className="topbar-session-pills">
              <div
                className={cn(
                  "topbar-status-pill",
                  `topbar-status-pill--${normalizeActivityLabelForClass(activity.label)}`,
                )}
              >
                <span className="topbar-status-pill__dot" style={{ background: activity.color }} />
                <span className="topbar-status-pill__label">{activity.label}</span>
              </div>
              {session.branch ? (
                pr ? (
                  <a
                    href={buildGitHubBranchUrl(pr)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="topbar-branch-pill topbar-branch-pill--link"
                  >
                    {session.branch}
                  </a>
                ) : (
                  <span className="topbar-branch-pill">{session.branch}</span>
                )
              ) : null}
              {isOrchestrator && orchestratorZones ? (
                <OrchestratorZonePills zones={orchestratorZones} />
              ) : null}
            </div>
          </div>
          {/* Desktop-only session title + session id.
            On mobile the session id lives next to the project name (above). */}
          <span className="dashboard-app-header__sep topbar-desktop-only" aria-hidden="true" />
          <span className="dashboard-app-header__session-title topbar-desktop-only">
            {headline}
          </span>
          <span className="dashboard-app-header__session-id topbar-desktop-only">
            {session.id}
          </span>
          <div className="dashboard-app-header__spacer" />
          <div className="dashboard-app-header__actions">
            {pr ? (
              <div className="topbar-pr-btn-wrap" ref={prPopoverRef}>
                {/* Anchored to the actual PR URL so ctrl/cmd-click opens the PR on
                  GitHub in a new tab. Plain click toggles the details popover. */}
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "dashboard-app-btn topbar-pr-btn",
                    prPopoverOpen && "topbar-pr-btn--open",
                  )}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
                    e.preventDefault();
                    setPrPopoverOpen((v) => !v);
                  }}
                  aria-expanded={prPopoverOpen}
                  aria-label={`PR #${pr.number}`}
                >
                  <span
                    className={cn(
                      "topbar-pr-dot",
                      allGreen
                        ? "topbar-pr-dot--green"
                        : pr.ciStatus === CI_STATUS.FAILING ||
                            pr.reviewDecision === "changes_requested"
                          ? "topbar-pr-dot--red"
                          : "topbar-pr-dot--amber",
                    )}
                  />
                  PR #{pr.number}
                  <svg
                    width="10"
                    height="10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d={prPopoverOpen ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
                  </svg>
                </a>

                {prPopoverOpen && (
                  <div className="topbar-pr-popover">
                    <SessionDetailPRCard
                      pr={pr}
                      sessionId={session.id}
                      metadata={session.metadata}
                    />
                  </div>
                )}
              </div>
            ) : null}

            {/* Restore is available for any restorable session; Kill stays worker-only. */}
            {isRestorable ? (
              <button
                type="button"
                className="dashboard-app-btn dashboard-app-btn--restore"
                onClick={handleRestore}
              >
                <svg
                  className="topbar-action-icon"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M20 11a8 8 0 0 0-14.9-3.98" />
                  <path d="M4 5v4h4" />
                  <path d="M4 13a8 8 0 0 0 14.9 3.98" />
                  <path d="M20 19v-4h-4" />
                </svg>
                <span className="topbar-btn-label">Restore</span>
              </button>
            ) : !isOrchestrator && !terminalEnded ? (
              <button
                type="button"
                className="dashboard-app-btn dashboard-app-btn--danger"
                onClick={handleKill}
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                <span className="topbar-btn-label">Kill</span>
              </button>
            ) : null}

            {orchestratorHref ? (
              <a
                href={orchestratorHref}
                className="dashboard-app-btn dashboard-app-btn--amber topbar-desktop-only"
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
                <span className="topbar-btn-label">Orchestrator</span>
              </a>
            ) : null}
          </div>
        </header>

        <div
          className={`dashboard-shell dashboard-shell--desktop${sidebarCollapsed ? " dashboard-shell--sidebar-collapsed" : ""}`}
        >
          {projects.length > 0 ? (
            <div
              className={`sidebar-wrapper${mobileSidebarOpen ? " sidebar-wrapper--mobile-open" : ""}`}
            >
              <ProjectSidebar
                projects={projects}
                sessions={sidebarSessions}
                loading={sidebarLoading}
                error={sidebarError}
                onRetry={onRetrySidebar}
                activeProjectId={session.projectId}
                activeSessionId={session.id}
                collapsed={sidebarCollapsed}
                onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
                onMobileClose={() => setMobileSidebarOpen(false)}
              />
            </div>
          ) : null}
          {mobileSidebarOpen && (
            <div className="sidebar-mobile-backdrop" onClick={() => setMobileSidebarOpen(false)} />
          )}

          <div className="dashboard-main dashboard-main--desktop">
            <main className="session-detail-page flex-1 min-h-0 flex flex-col bg-[var(--color-bg-base)]">
              {/* Terminal — fills all remaining height */}
              <div className="flex-1 min-h-0 flex flex-col">
                {!showTerminal ? (
                  <div className="session-detail-terminal-placeholder h-full" />
                ) : terminalEnded ? (
                  <SessionEndedSummary
                    session={session}
                    headline={headline}
                    pr={pr}
                    dashboardHref={dashboardHref}
                  />
                ) : (
                  <DirectTerminal
                    sessionId={session.id}
                    tmuxName={session.metadata?.tmuxName}
                    startFullscreen={startFullscreen}
                    variant={terminalVariant}
                    appearance="dark"
                    height="100%"
                    isOpenCodeSession={isOpenCodeSession}
                    reloadCommand={isOpenCodeSession ? reloadCommand : undefined}
                    autoFocus
                  />
                )}
              </div>
            </main>
          </div>
        </div>
        <MobileBottomNav
          ariaLabel="Session navigation"
          activeTab={isOrchestrator ? "orchestrator" : undefined}
          dashboardHref={dashboardHref}
          prsHref={
            session.projectId ? `/?project=${encodeURIComponent(session.projectId)}&tab=prs` : "/"
          }
          showOrchestrator={!!orchestratorHref}
          orchestratorHref={orchestratorHref}
        />
      </div>
    </SidebarContext.Provider>
  );
}

// ── Session detail PR card ────────────────────────────────────────────

function SessionDetailPRCard({
  pr,
  sessionId,
  metadata,
}: {
  pr: DashboardPR;
  sessionId: string;
  metadata: Record<string, string>;
}) {
  const [sendingComments, setSendingComments] = useState<Set<string>>(new Set());
  const [sentComments, setSentComments] = useState<Set<string>>(new Set());
  const [errorComments, setErrorComments] = useState<Set<string>>(new Set());
  const [branchCopied, setBranchCopied] = useState(false);
  const timersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const handleAskAgentToFix = async (comment: { url: string; path: string; body: string }) => {
    setSentComments((prev) => {
      const next = new Set(prev);
      next.delete(comment.url);
      return next;
    });
    setErrorComments((prev) => {
      const next = new Set(prev);
      next.delete(comment.url);
      return next;
    });
    setSendingComments((prev) => new Set(prev).add(comment.url));

    await askAgentToFix(
      sessionId,
      comment,
      () => {
        setSendingComments((prev) => {
          const next = new Set(prev);
          next.delete(comment.url);
          return next;
        });
        setSentComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing !== undefined) window.clearTimeout(existing);
        const timer = window.setTimeout(() => {
          setSentComments((prev) => {
            const next = new Set(prev);
            next.delete(comment.url);
            return next;
          });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
      () => {
        setSendingComments((prev) => {
          const next = new Set(prev);
          next.delete(comment.url);
          return next;
        });
        setErrorComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing !== undefined) window.clearTimeout(existing);
        const timer = window.setTimeout(() => {
          setErrorComments((prev) => {
            const next = new Set(prev);
            next.delete(comment.url);
            return next;
          });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
    );
  };

  const allGreen = isPRMergeReady(pr);
  const blockerIssues = buildBlockerChips(pr, metadata);
  const fileCount = pr.changedFiles ?? 0;

  const mergeabilityReliable = !isPRUnenriched(pr) && !isPRRateLimited(pr);
  const hasConflicts =
    mergeabilityReliable && pr.state !== "merged" && !pr.mergeability.noConflicts;
  const showConflictActions = hasConflicts && pr.state === "open";
  const compareUrl = showConflictActions ? buildGitHubCompareUrl(pr) : "";

  const handleCopyBranch = () => {
    const clipboardWrite = navigator.clipboard?.writeText(pr.branch);
    if (!clipboardWrite) return;

    void clipboardWrite
      .then(() => {
        setBranchCopied(true);
        const timerKey = "__copy-branch";
        const existing = timersRef.current.get(timerKey);
        if (existing !== undefined) window.clearTimeout(existing);
        const timer = window.setTimeout(() => {
          setBranchCopied(false);
          timersRef.current.delete(timerKey);
        }, 2000);
        timersRef.current.set(timerKey, timer);
      })
      .catch(() => {
        /* clipboard unavailable */
      });
  };

  return (
    <div className={cn("session-detail-pr-card", allGreen && "session-detail-pr-card--green")}>
      {/* Row 1: Title + diff stats */}
      <div className="session-detail-pr-card__row">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="session-detail-pr-card__title-link"
        >
          PR #{pr.number}: {pr.title}
        </a>
        <span className="session-detail-pr-card__diff-stats">
          <span className="session-detail-diff--add">+{pr.additions}</span>{" "}
          <span className="session-detail-diff--del">-{pr.deletions}</span>
        </span>
        {fileCount > 0 && (
          <span className="session-detail-pr-card__diff-label">
            {fileCount} file{fileCount !== 1 ? "s" : ""}
          </span>
        )}
        {pr.isDraft && <span className="session-detail-pr-card__diff-label">Draft</span>}
        {pr.state === "merged" && (
          <span className="session-detail-pr-card__diff-label">Merged</span>
        )}
      </div>

      {showConflictActions ? (
        <div
          className="session-detail-pr-card__merge-actions"
          role="group"
          aria-label="Resolve merge conflicts"
        >
          <a
            href={compareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="session-detail-pr-merge-action"
          >
            Compare with base branch
          </a>
          <button
            type="button"
            onClick={handleCopyBranch}
            aria-label={branchCopied ? "Head branch name copied" : "Copy head branch name"}
            className="session-detail-pr-merge-action session-detail-pr-merge-action--btn"
          >
            {branchCopied ? "Copied branch name" : "Copy head branch name"}
          </button>
        </div>
      ) : null}

      {/* Row 2: Blocker chips + CI chips inline */}
      <div className="session-detail-pr-card__details">
        {allGreen ? (
          <div className="session-detail-merge-banner">
            <svg
              width="11"
              height="11"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Ready to merge
          </div>
        ) : (
          blockerIssues.map((issue) => (
            <span
              key={issue.text}
              className={cn(
                "session-detail-blocker-chip",
                issue.variant === "fail" && "session-detail-blocker-chip--fail",
                issue.variant === "warn" && "session-detail-blocker-chip--warn",
                issue.variant === "muted" && "session-detail-blocker-chip--muted",
              )}
            >
              {issue.icon} {issue.text}
              {issue.notified && (
                <span className="session-detail-blocker-chip__note">· notified</span>
              )}
            </span>
          ))
        )}

        {/* Separator between blockers and CI chips */}
        {pr.ciChecks.length > 0 && (
          <>
            <div className="session-detail-pr-sep" />
            {pr.ciChecks.map((check) => {
              const chip = (
                <span
                  className={cn(
                    "session-detail-ci-chip",
                    check.status === "passed" && "session-detail-ci-chip--pass",
                    check.status === "failed" && "session-detail-ci-chip--fail",
                    check.status === "pending" && "session-detail-ci-chip--pending",
                    check.status !== "passed" &&
                      check.status !== "failed" &&
                      check.status !== "pending" &&
                      "session-detail-ci-chip--queued",
                  )}
                >
                  {check.status === "passed"
                    ? "\u2713"
                    : check.status === "failed"
                      ? "\u2717"
                      : check.status === "pending"
                        ? "\u25CF"
                        : "\u25CB"}{" "}
                  {check.name}
                </span>
              );
              return check.url ? (
                <a
                  key={check.name}
                  href={check.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:no-underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {chip}
                </a>
              ) : (
                <span key={check.name}>{chip}</span>
              );
            })}
          </>
        )}
      </div>

      {/* Row 3: Collapsible unresolved comments */}
      {pr.unresolvedComments.length > 0 && (
        <details className="session-detail-comments-strip">
          <summary>
            <div className="session-detail-comments-strip__toggle">
              <svg
                className="session-detail-comments-strip__chevron"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                viewBox="0 0 24 24"
              >
                <path d="M9 5l7 7-7 7" />
              </svg>
              <span className="session-detail-comments-strip__label">Unresolved Comments</span>
              <span className="session-detail-comments-strip__count">{pr.unresolvedThreads}</span>
              <span className="session-detail-comments-strip__hint">click to expand</span>
            </div>
          </summary>
          <div className="session-detail-comments-strip__body">
            {pr.unresolvedComments.map((c, index) => {
              const { title, description } = cleanBugbotComment(c.body);
              return (
                <details key={c.url} className="session-detail-comment" open={index === 0}>
                  <summary>
                    <div className="session-detail-comment__row">
                      <svg
                        className="session-detail-comment__chevron"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <path d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="session-detail-comment__title">{title}</span>
                      <span className="session-detail-comment__author">· {c.author}</span>
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="session-detail-comment__view"
                      >
                        view &rarr;
                      </a>
                    </div>
                  </summary>
                  <div className="session-detail-comment__body">
                    <div className="session-detail-comment__file">{c.path}</div>
                    <p className="session-detail-comment__text">{description}</p>
                    <button
                      onClick={() => handleAskAgentToFix(c)}
                      disabled={sendingComments.has(c.url)}
                      className={cn(
                        "session-detail-comment__fix-btn",
                        sentComments.has(c.url) && "session-detail-comment__fix-btn--sent",
                        errorComments.has(c.url) && "session-detail-comment__fix-btn--error",
                      )}
                    >
                      {sendingComments.has(c.url)
                        ? "Sending\u2026"
                        : sentComments.has(c.url)
                          ? "Sent \u2713"
                          : errorComments.has(c.url)
                            ? "Failed"
                            : "Ask Agent to Fix"}
                    </button>
                  </div>
                </details>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

// ── Blocker chips helper (pre-merge blockers) ───────────────────────

interface BlockerChip {
  icon: string;
  text: string;
  variant: "fail" | "warn" | "muted";
  notified?: boolean;
}

function buildBlockerChips(pr: DashboardPR, metadata: Record<string, string>): BlockerChip[] {
  const chips: BlockerChip[] = [];

  const ciNotified = Boolean(metadata["lastCIFailureDispatchHash"]);
  const conflictNotified = metadata["lastMergeConflictDispatched"] === "true";
  const reviewNotified = Boolean(metadata["lastPendingReviewDispatchHash"]);
  const lifecycleStatus = metadata["status"];

  const ciIsFailing = pr.ciStatus === CI_STATUS.FAILING || lifecycleStatus === "ci_failed";
  const hasChangesRequested =
    pr.reviewDecision === "changes_requested" || lifecycleStatus === "changes_requested";
  const mergeabilityReliable = !isPRUnenriched(pr) && !isPRRateLimited(pr);
  const hasConflicts =
    mergeabilityReliable && pr.state !== "merged" && !pr.mergeability.noConflicts;

  if (ciIsFailing) {
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    chips.push({
      icon: "\u2717",
      variant: "fail",
      text:
        failCount > 0 ? `${failCount} check${failCount !== 1 ? "s" : ""} failing` : "CI failing",
      notified: ciNotified,
    });
  } else if (pr.ciStatus === CI_STATUS.PENDING) {
    chips.push({ icon: "\u25CF", variant: "warn", text: "CI pending" });
  }

  if (hasChangesRequested) {
    chips.push({
      icon: "\u2717",
      variant: "fail",
      text: "Changes requested",
      notified: reviewNotified,
    });
  } else if (!pr.mergeability.approved) {
    chips.push({ icon: "\u25CB", variant: "muted", text: "Awaiting reviewer" });
  }

  if (hasConflicts) {
    chips.push({
      icon: "\u2717",
      variant: "fail",
      text: "Merge conflicts",
      notified: conflictNotified,
    });
  }

  if (pr.isDraft) {
    chips.push({ icon: "\u25CB", variant: "muted", text: "Draft" });
  }

  return chips;
}
