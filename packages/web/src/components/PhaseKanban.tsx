"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type DashboardSession,
  type DashboardOrchestratorLink,
  type SessionStatus,
} from "@/lib/types";
import { PhaseLane } from "./PhaseLane";
import { PHASE_LANES, DONE_PHASES } from "@/lib/phases";
import { ProjectSidebar } from "./ProjectSidebar";
import { DynamicFavicon } from "./DynamicFavicon";
import { ConnectionBar } from "./ConnectionBar";
import { ToastProvider, useToast } from "./Toast";
import { MobileBottomNav } from "./MobileBottomNav";
import { DesktopAppMenu } from "./DesktopAppMenu";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { useMuxOptional } from "@/providers/MuxProvider";
import { getProjectScopedHref } from "@/lib/project-utils";
import type { ProjectInfo } from "@/lib/project-name";

interface PhaseKanbanProps {
  initialSessions: DashboardSession[];
  projectId?: string;
  projectName?: string;
  projects?: ProjectInfo[];
  orchestrators?: DashboardOrchestratorLink[];
}

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

export function PhaseKanban(props: PhaseKanbanProps) {
  return (
    <ToastProvider>
      <PhaseKanbanInner {...props} />
    </ToastProvider>
  );
}

function PhaseKanbanInner({
  initialSessions,
  projectId,
  projectName,
  projects = [],
  orchestrators,
}: PhaseKanbanProps) {
  const orchestratorLinks = orchestrators ?? EMPTY_ORCHESTRATORS;
  const mux = useMuxOptional();
  const { sessions, connectionStatus, sseAttentionLevels } = useSessionEvents(
    initialSessions,
    projectId,
    mux?.status === "connected" ? mux.sessions : undefined,
    undefined,
    false,
  );

  const router = useRouter();
  const searchParams = useSearchParams();
  const expanded = searchParams.get("subphases") === "1";

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const { showToast } = useToast();
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const showSidebar = projects.length >= 1;

  const currentProjectOrchestrator = useMemo(
    () =>
      projectId
        ? (orchestratorLinks.find((orchestrator) => orchestrator.projectId === projectId) ?? null)
        : null,
    [orchestratorLinks, projectId],
  );
  const dashboardHref = getProjectScopedHref("/", projectId);
  const prsHref = getProjectScopedHref("/prs", projectId);
  const phasesHref = getProjectScopedHref("/phases", projectId);
  const orchestratorHref = currentProjectOrchestrator
    ? `/sessions/${encodeURIComponent(currentProjectOrchestrator.id)}`
    : null;

  const { lanes, doneSessions } = useMemo(() => {
    const laneBuckets: Record<string, Partial<Record<SessionStatus, DashboardSession[]>>> = {};
    for (const lane of PHASE_LANES) {
      laneBuckets[lane.id] = {};
    }
    const done: DashboardSession[] = [];

    for (const session of sessions) {
      if (DONE_PHASES.includes(session.status)) {
        done.push(session);
        continue;
      }
      const targetLane = PHASE_LANES.find((lane) => lane.statuses.includes(session.status));
      // Fall back to the "attention" lane if an unknown status slips in.
      const laneId = targetLane?.id ?? "attention";
      const bucket = laneBuckets[laneId] ?? {};
      laneBuckets[laneId] = bucket;
      const key = session.status;
      (bucket[key] ??= []).push(session);
    }

    return { lanes: laneBuckets, doneSessions: done };
  }, [sessions]);

  const toggleSubphases = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (expanded) {
      params.delete("subphases");
    } else {
      params.set("subphases", "1");
    }
    const query = params.toString();
    router.replace(query ? `/phases?${query}` : "/phases");
  }, [expanded, router, searchParams]);

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
          showToast("Network error while sending message", "error");
        }
        throw error;
      }
    },
    [showToast],
  );

  const handleKill = useCallback(
    async (sessionId: string) => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
          method: "POST",
        });
        if (!res.ok) {
          const text = await res.text();
          showToast(`Terminate failed: ${text}`, "error");
        } else {
          showToast("Session terminated", "success");
        }
      } catch {
        showToast("Network error while terminating session", "error");
      }
    },
    [showToast],
  );

  const handleMerge = useCallback(
    async (prNumber: number) => {
      try {
        const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
        if (!res.ok) {
          const text = await res.text();
          showToast(`Merge failed: ${text}`, "error");
        } else {
          showToast(`PR #${prNumber} merged`, "success");
        }
      } catch {
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
          showToast(`Restore failed: ${text}`, "error");
        } else {
          showToast("Session restored", "success");
        }
      } catch {
        showToast("Network error while restoring session", "error");
      }
    },
    [showToast],
  );

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [searchParams]);

  return (
    <>
      <ConnectionBar status={connectionStatus} />
      <div className="dashboard-app-shell">
        <header className="dashboard-app-header">
          <DesktopAppMenu
            activeTab="phases"
            dashboardHref={dashboardHref}
            prsHref={prsHref}
            phasesHref={phasesHref}
            showOrchestrator
            orchestratorHref={orchestratorHref}
          />
          <div className="dashboard-app-header__brand">
            <span className="dashboard-app-header__brand-dot" aria-hidden="true" />
            <span>Agent Orchestrator</span>
          </div>
          <span className="dashboard-app-header__sep" aria-hidden="true" />
          <Link href={dashboardHref} className="dashboard-app-header__project">
            Dashboard
          </Link>
          <div className="dashboard-app-header__spacer" />
          <div className="dashboard-app-header__actions">
            <button
              type="button"
              className="dashboard-app-btn"
              onClick={toggleSubphases}
              aria-pressed={expanded}
              title={expanded ? "Collapse lanes into single columns" : "Expand lanes into per-status sub-columns"}
            >
              {expanded ? "Hide sub-phases" : "Show sub-phases"}
            </button>
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

        <div className="dashboard-shell dashboard-shell--desktop">
          {showSidebar && (
            <ProjectSidebar
              projects={projects}
              sessions={sessions}
              activeProjectId={projectId}
              activeSessionId={undefined}
              collapsed={false}
              mobileOpen={mobileMenuOpen}
              onMobileClose={() => setMobileMenuOpen(false)}
            />
          )}

          <main className="dashboard-main dashboard-main--desktop">
            <DynamicFavicon sseAttentionLevels={sseAttentionLevels} projectName={projectName} />
            <div className="dashboard-main__subhead">
              <h1 className="dashboard-main__title">Kanban</h1>
              <p className="dashboard-main__subtitle">
                Lifecycle phases — where each session is. {projectName ? `· ${projectName}` : null}
              </p>
            </div>

            <div className="dashboard-main__body">
              <div className="kanban-board-wrap">
                <div
                  className="kanban-board phase-lanes-board"
                  data-expanded={expanded ? "true" : "false"}
                >
                  {PHASE_LANES.map((lane) => (
                    <PhaseLane
                      key={lane.id}
                      laneId={lane.id}
                      label={lane.label}
                      description={lane.description}
                      statuses={lane.statuses}
                      sessionsByStatus={lanes[lane.id] ?? {}}
                      expanded={expanded}
                      onSend={handleSend}
                      onKill={handleKill}
                      onMerge={handleMerge}
                      onRestore={handleRestore}
                    />
                  ))}
                </div>
              </div>

              {doneSessions.length > 0 && (
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
                    <span className="done-bar__count">{doneSessions.length}</span>
                  </button>
                  {doneExpanded && (
                    <div className="done-bar__cards">
                      {doneSessions.map((session) => (
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
      <MobileBottomNav
        ariaLabel="Primary"
        activeTab="phases"
        dashboardHref={dashboardHref}
        prsHref={prsHref}
        phasesHref={phasesHref}
        showOrchestrator
        orchestratorHref={orchestratorHref}
      />
    </>
  );
}
