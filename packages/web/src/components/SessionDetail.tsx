"use client";

import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
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
import { getSessionTitle } from "@/lib/format";
import type { ProjectInfo } from "@/lib/project-name";

import { MobileBottomNav } from "./MobileBottomNav";
import { ProjectSidebar } from "./ProjectSidebar";

const DirectTerminal = dynamic(
  () => import("./DirectTerminal").then((m) => ({ default: m.DirectTerminal })),
  {
    ssr: false,
    loading: () => (
      <div className="h-[440px] animate-pulse rounded bg-[var(--color-bg-primary)]" />
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
  sidebarSessions?: DashboardSession[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatTimeCompact(isoDate: string | null): string {
  if (!isoDate) return "just now";
  const ts = new Date(isoDate).getTime();
  if (!Number.isFinite(ts)) return "just now";
  const diffMs = Date.now() - ts;
  if (diffMs <= 0) return "just now";
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function getCiDotBg(pr: DashboardPR): string {
  if (isPRRateLimited(pr) || isPRUnenriched(pr)) return "var(--color-text-tertiary)";
  if (pr.ciStatus === "passing") return "var(--color-accent-green)";
  if (pr.ciStatus === "failing") return "var(--color-accent-red)";
  return "var(--color-status-attention)";
}

function getCiShortLabel(pr: DashboardPR): string {
  if (isPRRateLimited(pr) || isPRUnenriched(pr)) return "CI";
  if (pr.ciStatus === "passing") return "CI passing";
  if (pr.ciStatus === "failing") return "CI failed";
  return "CI pending";
}

function getReviewShortLabel(pr: DashboardPR): string {
  if (isPRRateLimited(pr) || isPRUnenriched(pr)) return "";
  if (pr.reviewDecision === "approved") return "approved";
  if (pr.reviewDecision === "changes_requested") return "changes";
  return "review";
}

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

function activityStateClass(activityLabel: string): string {
  const normalized = activityLabel.toLowerCase();
  if (normalized === "active") return "session-detail-status-pill--active";
  if (normalized === "ready") return "session-detail-status-pill--ready";
  if (normalized === "idle") return "session-detail-status-pill--idle";
  if (normalized === "waiting for input") return "session-detail-status-pill--waiting";
  if (normalized === "blocked" || normalized === "exited") {
    return "session-detail-status-pill--error";
  }
  return "session-detail-status-pill--neutral";
}

function SessionTopStrip({
  headline,
  crumbId,
  activityLabel,
  activityColor,
  branch,
  pr,
  isOrchestrator = false,
  crumbHref,
  crumbLabel,
  rightSlot,
  onKill,
  onRestore,
}: {
  headline: string;
  crumbId: string;
  activityLabel: string;
  activityColor: string;
  branch: string | null;
  pr: DashboardPR | null;
  isOrchestrator?: boolean;
  crumbHref: string;
  crumbLabel: string;
  rightSlot?: ReactNode;
  onKill?: () => void;
  onRestore?: () => void;
}) {
  return (
    <div className="session-detail-top-strip">
      {/* Breadcrumbs */}
      <div className="session-detail-crumbs">
        <a
          href={crumbHref}
          className="session-detail-crumb-back"
        >
          <svg
            className="h-3 w-3 opacity-60"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            viewBox="0 0 24 24"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {crumbLabel}
        </a>
        <span className="session-detail-crumb-sep">/</span>
        <span className="session-detail-crumb-id">{crumbId}</span>
        {isOrchestrator ? (
          <span className="session-detail-mode-badge">orchestrator</span>
        ) : null}
      </div>

      {/* Identity strip */}
      <div className="session-detail-identity">
        <div className="session-detail-identity__info">
          <h1 className="session-detail-identity__title">
            {headline}
          </h1>
          <div className="session-detail-identity__pills">
            <div
              className={cn(
                "session-detail-status-pill",
                activityStateClass(activityLabel),
              )}
            >
              <span
                className="session-detail-status-pill__dot"
                style={{ background: activityColor }}
              />
              <span className="session-detail-status-pill__label">
                {activityLabel}
              </span>
            </div>
            {branch ? (
              pr ? (
                <a
                  href={buildGitHubBranchUrl(pr)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="session-detail-link-pill session-detail-link-pill--branch session-detail-link-pill--branch-link hover:no-underline"
                >
                  {branch}
                </a>
              ) : (
                <span className="session-detail-link-pill session-detail-link-pill--branch">
                  {branch}
                </span>
              )
            ) : null}
            {pr ? (
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="session-detail-link-pill session-detail-link-pill--pr hover:no-underline"
              >
                PR #{pr.number}
              </a>
            ) : null}
            {pr && (pr.additions > 0 || pr.deletions > 0) ? (
              <span className="session-detail-link-pill session-detail-link-pill--diff">
                <span className="session-detail-diff--add">+{pr.additions}</span>
                {" "}
                <span className="session-detail-diff--del">-{pr.deletions}</span>
              </span>
            ) : null}
          </div>
        </div>

        {rightSlot ? (
          <div className="session-detail-identity__actions session-detail-identity__actions--custom">
            {rightSlot}
          </div>
        ) : (
          <div className="session-detail-identity__actions">
            {onRestore ? (
              <button
                type="button"
                className="done-restore-btn"
                onClick={onRestore}
              >
                <svg
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  className="h-3 w-3"
                >
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
                Restore
              </button>
            ) : onKill ? (
              <button
                type="button"
                className="session-detail-action-btn session-detail-action-btn--danger"
                onClick={onKill}
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Kill
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
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

// ── Orchestrator status strip ─────────────────────────────────────────

function _OrchestratorStatusStrip({
  zones,
  createdAt,
  headline,
  activityLabel,
  activityColor,
  branch,
  pr,
  crumbHref,
  crumbLabel,
}: {
  zones: OrchestratorZones;
  createdAt: string;
  headline: string;
  activityLabel: string;
  activityColor: string;
  branch: string | null;
  pr: DashboardPR | null;
  crumbHref: string;
  crumbLabel: string;
}) {
  const [uptime, setUptime] = useState<string>("");

  useEffect(() => {
    const compute = () => {
      const diff = Date.now() - new Date(createdAt).getTime();
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      setUptime(h > 0 ? `${h}h ${m}m` : `${m}m`);
    };
    compute();
    const id = setInterval(compute, 30_000);
    return () => clearInterval(id);
  }, [createdAt]);

  const stats: Array<{ value: number; label: string; color: string; bg: string }> = [
    {
      value: zones.merge,
      label: "merge-ready",
      color: "var(--color-status-ready)",
      bg: "color-mix(in srgb, var(--color-status-ready) 10%, transparent)",
    },
    {
      value: zones.respond,
      label: "responding",
      color: "var(--color-status-error)",
      bg: "color-mix(in srgb, var(--color-status-error) 10%, transparent)",
    },
    {
      value: zones.review,
      label: "review",
      color: "var(--color-accent-orange)",
      bg: "color-mix(in srgb, var(--color-accent-orange) 10%, transparent)",
    },
    {
      value: zones.working,
      label: "working",
      color: "var(--color-accent-blue)",
      bg: "color-mix(in srgb, var(--color-accent-blue) 10%, transparent)",
    },
    {
      value: zones.pending,
      label: "pending",
      color: "var(--color-status-attention)",
      bg: "color-mix(in srgb, var(--color-status-attention) 10%, transparent)",
    },
    {
      value: zones.done,
      label: "done",
      color: "var(--color-text-tertiary)",
      bg: "color-mix(in srgb, var(--color-text-tertiary) 14%, transparent)",
    },
  ].filter((s) => s.value > 0);

  const total =
    zones.merge + zones.respond + zones.review + zones.working + zones.pending + zones.done;

  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-5 lg:px-8">
      <SessionTopStrip
        headline={headline}
        crumbId={headline}
        activityLabel={activityLabel}
        activityColor={activityColor}
        branch={branch}
        pr={pr}
        isOrchestrator
        crumbHref={crumbHref}
        crumbLabel={crumbLabel}
        rightSlot={
          <div className="flex flex-wrap items-center gap-3 lg:justify-end">
            <div className="flex items-baseline gap-1.5 mr-2">
              <span className="text-[22px] font-bold leading-none tabular-nums text-[var(--color-text-primary)]">
                {total}
              </span>
              <span className="text-[11px] text-[var(--color-text-tertiary)]">agents</span>
            </div>

            <div className="h-5 w-px bg-[var(--color-border-subtle)] mr-1" />

            {/* Per-zone pills */}
            {stats.length > 0 ? (
              stats.map((s) => (
                <div
                  key={s.label}
                  className="flex items-center gap-1.5 px-2.5 py-1"
                  style={{ background: s.bg }}
                >
                  <span
                    className="text-[15px] font-bold leading-none tabular-nums"
                    style={{ color: s.color }}
                  >
                    {s.value}
                  </span>
                  <span
                    className="text-[10px] font-medium"
                    style={{ color: s.color, opacity: 0.8 }}
                  >
                    {s.label}
                  </span>
                </div>
              ))
            ) : (
              <span className="text-[12px] text-[var(--color-text-tertiary)]">
                no active agents
              </span>
            )}

            {uptime && (
              <span className="ml-auto font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
                up {uptime}
              </span>
            )}
          </div>
        }
      />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────

export function SessionDetail({
  session,
  isOrchestrator = false,
  orchestratorZones,
  projectOrchestratorId = null,
  projects = [],
  sidebarSessions = [],
}: SessionDetailProps) {
  const searchParams = useSearchParams();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const pr = session.pr;
  const terminalEnded = TERMINAL_STATUSES.has(session.status);
  const isRestorable = terminalEnded && !NON_RESTORABLE_STATUSES.has(session.status);
  const activity = (session.activity && activityMeta[session.activity]) ?? {
    label: session.activity ?? "unknown",
    color: "var(--color-text-muted)",
  };
  const headline = getSessionTitle(session);

  const accentColor = "var(--color-accent)";
  const terminalVariant = isOrchestrator ? "orchestrator" : "agent";

  const terminalHeight = isOrchestrator
    ? "clamp(400px, 52vh, 620px)"
    : "clamp(380px, 48vh, 560px)";
  const isOpenCodeSession = session.metadata["agent"] === "opencode";
  const opencodeSessionId =
    typeof session.metadata["opencodeSessionId"] === "string" &&
    session.metadata["opencodeSessionId"].length > 0
      ? session.metadata["opencodeSessionId"]
      : undefined;
  const reloadCommand = opencodeSessionId
    ? `/exit\nopencode --session ${opencodeSessionId}\n`
    : undefined;
  const dashboardHref = session.projectId ? `/?project=${encodeURIComponent(session.projectId)}` : "/";
  const prsHref = session.projectId ? `/prs?project=${encodeURIComponent(session.projectId)}` : "/prs";
  const crumbHref = dashboardHref;
  const crumbLabel = "Dashboard";

  const handleKill = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/kill`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.reload();
    } catch (err) {
      console.error("Failed to kill session:", err);
    }
  }, [session.id]);

  const handleRestore = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/restore`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.reload();
    } catch (err) {
      console.error("Failed to restore session:", err);
    }
  }, [session.id]);
  const headerProjectLabel =
    projects.find((project) => project.id === session.projectId)?.name ?? session.projectId;
  const showHeaderProjectLabel =
    headerProjectLabel.trim().toLowerCase() !== "agent orchestrator";
  const orchestratorHref = useMemo(() => {
    if (isOrchestrator) return `/sessions/${encodeURIComponent(session.id)}`;
    if (!projectOrchestratorId) return null;
    return `/sessions/${encodeURIComponent(projectOrchestratorId)}`;
  }, [isOrchestrator, projectOrchestratorId, session.id]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setShowTerminal(true));
    return () => {
      window.cancelAnimationFrame(frame);
      setShowTerminal(false);
    };
  }, [session.id]);

  if (!isMobile) {
    return (
      <div className="dashboard-app-shell">
        <header className="dashboard-app-header">
          {projects.length > 0 ? (
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
            {orchestratorHref ? (
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
          {projects.length > 0 ? (
            <ProjectSidebar
              projects={projects}
              sessions={sidebarSessions}
              activeProjectId={session.projectId}
              activeSessionId={session.id}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
            />
          ) : null}

          <div className="dashboard-main dashboard-main--desktop">
            <main className="session-detail-page min-h-0 flex-1 overflow-y-auto bg-[var(--color-bg-base)]">
              <div className="session-detail-layout">
                <main className="min-w-0">
                  {(!isOrchestrator || (isOrchestrator && orchestratorZones)) && (
                    <SessionTopStrip
                      headline={headline}
                      crumbId={session.id}
                      activityLabel={activity.label}
                      activityColor={activity.color}
                      branch={session.branch}
                      pr={pr}
                      isOrchestrator={isOrchestrator}
                      crumbHref={crumbHref}
                      crumbLabel={crumbLabel}
                      onKill={isOrchestrator || terminalEnded ? undefined : handleKill}
                      onRestore={isOrchestrator || !isRestorable ? undefined : handleRestore}
                    />
                  )}

                  {pr ? (
                    <section id="session-pr-section" className="session-detail-pr-section">
                      <SessionDetailPRCard
                        pr={pr}
                        sessionId={session.id}
                        metadata={session.metadata}
                      />
                    </section>
                  ) : null}

                  <section className="session-detail-terminal-wrap">
                    <div id="session-terminal-section" aria-hidden="true" />
                    <div className="session-detail-section-label">
                      <div
                        className="session-detail-section-label__bar"
                        style={{ background: isOrchestrator ? accentColor : activity.color }}
                      />
                      <span className="session-detail-section-label__text">
                        Live Terminal
                      </span>
                    </div>
                    {!showTerminal ? (
                      <div className="session-detail-terminal-placeholder" style={{ height: terminalHeight }} />
                    ) : terminalEnded ? (
                      <div className="terminal-exited-placeholder" style={{ height: terminalHeight }}>
                        <span className="terminal-exited-placeholder__text">
                          Terminal session has ended
                        </span>
                      </div>
                    ) : (
                      <DirectTerminal
                        sessionId={session.id}
                        startFullscreen={startFullscreen}
                        variant={terminalVariant}
                        appearance="dark"
                        height={terminalHeight}
                        isOpenCodeSession={isOpenCodeSession}
                        reloadCommand={isOpenCodeSession ? reloadCommand : undefined}
                      />
                    )}
                  </section>
                </main>
              </div>
            </main>
          </div>
        </div>
      </div>
    );
  }

  const statusPillBg = activity.color === "var(--color-status-working)"
    ? "color-mix(in srgb, var(--color-status-working) 12%, transparent)"
    : activity.color === "var(--color-status-attention)"
      ? "color-mix(in srgb, var(--color-status-attention) 12%, transparent)"
      : activity.color === "var(--color-status-error)"
        ? "color-mix(in srgb, var(--color-status-error) 12%, transparent)"
        : "color-mix(in srgb, var(--color-accent) 12%, transparent)";

  return (
    <div className="session-detail--terminal-first">
      {/* Floating header */}
      <div className="session-detail__floating-header">
        <a href={crumbHref} className="session-detail__back" aria-label="Back to dashboard">
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </a>
        <span className="session-detail__status-dot" style={{ background: activity.color }} />
        <span className="session-detail__session-id">{session.id}</span>
        <span
          className="session-detail__status-pill"
          style={{ background: statusPillBg, color: activity.color }}
        >
          {activity.label.toLowerCase()}
        </span>
        <span className="session-detail__time">
          {formatTimeCompact(session.lastActivityAt)}
        </span>
      </div>

      {/* Terminal fills the viewport */}
      <div className={`session-detail__terminal-full${pr ? " session-detail__terminal-full--with-sheet" : ""}`}>
        {!showTerminal ? (
          <div className="session-detail-terminal-placeholder" style={{ height: "100%" }} />
        ) : terminalEnded ? (
          <div className="terminal-exited-placeholder" style={{ height: "100%" }}>
            <span className="terminal-exited-placeholder__text">
              Terminal session has ended
            </span>
          </div>
        ) : (
          <DirectTerminal
            sessionId={session.id}
            startFullscreen={startFullscreen}
            variant={terminalVariant}
            appearance="dark"
            height="100%"
            chromeless
            isOpenCodeSession={isOpenCodeSession}
            reloadCommand={isOpenCodeSession ? reloadCommand : undefined}
          />
        )}
      </div>

      {/* Bottom sheet with PR info */}
      {pr ? (
        <div className="session-detail__bottom-sheet">
          <div className="session-detail__sheet-handle" />
          <div className="session-detail__sheet-row">
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="session-detail__sheet-pr"
            >
              PR #{pr.number}
            </a>
            <span className="session-detail__sheet-item">
              <span
                className="session-detail__sheet-ci-dot"
                style={{ background: getCiDotBg(pr) }}
              />
              {getCiShortLabel(pr)}
            </span>
            <span className="session-detail__sheet-item">
              {getReviewShortLabel(pr) || "—"}
            </span>
          </div>
        </div>
      ) : null}

      <MobileBottomNav
        ariaLabel="Session navigation"
        activeTab={isOrchestrator ? "orchestrator" : undefined}
        dashboardHref={dashboardHref}
        prsHref={prsHref}
        showOrchestrator={orchestratorHref !== null}
        orchestratorHref={orchestratorHref}
      />
    </div>
  );
}

// ── Session detail PR card ────────────────────────────────────────────

function SessionDetailPRCard({ pr, sessionId, metadata }: { pr: DashboardPR; sessionId: string; metadata: Record<string, string> }) {
  const [sendingComments, setSendingComments] = useState<Set<string>>(new Set());
  const [sentComments, setSentComments] = useState<Set<string>>(new Set());
  const [errorComments, setErrorComments] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
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
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
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
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
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
        {pr.isDraft && (
          <span className="session-detail-pr-card__diff-label">Draft</span>
        )}
        {pr.state === "merged" && (
          <span className="session-detail-pr-card__diff-label">Merged</span>
        )}
      </div>

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
                    check.status !== "passed" && check.status !== "failed" && check.status !== "pending" && "session-detail-ci-chip--queued",
                  )}
                >
                  {check.status === "passed" ? "\u2713" : check.status === "failed" ? "\u2717" : check.status === "pending" ? "\u25CF" : "\u25CB"}{" "}
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
  const hasConflicts = pr.state !== "merged" && !pr.mergeability.noConflicts;

  if (ciIsFailing) {
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    chips.push({
      icon: "\u2717",
      variant: "fail",
      text: failCount > 0 ? `${failCount} check${failCount !== 1 ? "s" : ""} failing` : "CI failing",
      notified: ciNotified,
    });
  } else if (pr.ciStatus === CI_STATUS.PENDING) {
    chips.push({ icon: "\u25CF", variant: "warn", text: "CI pending" });
  }

  if (hasChangesRequested) {
    chips.push({ icon: "\u2717", variant: "fail", text: "Changes requested", notified: reviewNotified });
  } else if (!pr.mergeability.approved) {
    chips.push({ icon: "\u25CB", variant: "muted", text: "Awaiting reviewer" });
  }

  if (hasConflicts) {
    chips.push({ icon: "\u2717", variant: "fail", text: "Merge conflicts", notified: conflictNotified });
  }

  if (pr.isDraft) {
    chips.push({ icon: "\u25CB", variant: "muted", text: "Draft" });
  }

  return chips;
}
