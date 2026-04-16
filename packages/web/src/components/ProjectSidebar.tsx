"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";
import { getAttentionLevel, type DashboardSession, type AttentionLevel } from "@/lib/types";
import { isOrchestratorSession } from "@aoagents/ao-core/types";
import { getSessionTitle } from "@/lib/format";
import { ThemeToggle } from "./ThemeToggle";

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  sessions: DashboardSession[] | null;
  activeProjectId: string | undefined;
  activeSessionId: string | undefined;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

type SessionDotLevel =
  | "respond"
  | "review"
  | "action"
  | "pending"
  | "working"
  | "merge"
  | "done";

function SessionDot({ level }: { level: SessionDotLevel }) {
  return (
    <div
      className={cn(
        "sidebar-session-dot shrink-0 rounded-full",
        level === "working" && "sidebar-session-dot--glow",
      )}
      data-level={level}
    />
  );
}

// ProjectSidebar consumes `getAttentionLevel()` without passing a mode,
// so the function defaults to "detailed" and `action` never appears here
// in practice. The entry is kept for exhaustiveness — TypeScript requires
// every `AttentionLevel` variant to be present in this `Record` — and
// as forward-compat in case the sidebar ever opts into simple mode.
const LEVEL_LABELS: Record<AttentionLevel, string> = {
  working: "working",
  pending: "pending",
  review: "review",
  respond: "respond",
  action: "action",
  merge: "merge",
  done: "done",
};

export function ProjectSidebar(props: ProjectSidebarProps) {
  if (props.projects.length === 0) {
    return null;
  }
  return <ProjectSidebarInner {...props} />;
}

function ProjectSidebarInner({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  loading = false,
  error = false,
  onRetry,
  collapsed = false,
  onToggleCollapsed: _onToggleCollapsed,
  mobileOpen: _mobileOpen = false,
  onMobileClose,
}: ProjectSidebarProps) {
  const router = useRouter();
  const isLoading = loading || sessions === null;

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(activeProjectId && activeProjectId !== "all" ? [activeProjectId] : []),
  );
  const [showKilled, setShowKilled] = useState(false);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    if (activeProjectId && activeProjectId !== "all") {
      setExpandedProjects((prev) => new Set([...prev, activeProjectId]));
    }
  }, [activeProjectId]);

  const prefixByProject = useMemo(
    () => new Map(projects.map((p) => [p.id, p.sessionPrefix ?? p.id])),
    [projects],
  );

  const allPrefixes = useMemo(
    () => projects.map((p) => p.sessionPrefix ?? p.id),
    [projects],
  );

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, DashboardSession[]>();
    // Build a set of valid project IDs to filter sessions strictly
    const validProjectIds = new Set(projects.map((p) => p.id));

    for (const s of sessions) {
      // Only include sessions whose projectId matches a configured project
      if (!validProjectIds.has(s.projectId)) continue;
      if (isOrchestratorSession(s, prefixByProject.get(s.projectId), allPrefixes)) continue;
      // Filter by status visibility
      if (s.status === "killed" && !showKilled) continue;
      if (s.status === "done" && !showDone) continue;
      const list = map.get(s.projectId) ?? [];
      list.push(s);
      map.set(s.projectId, list);
    }
    return map;
  }, [sessions, prefixByProject, allPrefixes, projects, showKilled, showDone]);

  const navigate = (url: string, session?: DashboardSession) => {
    if (session) {
      try {
        sessionStorage.setItem(`ao-session-nav:${session.id}`, JSON.stringify(session));
      } catch {
        // sessionStorage unavailable — silent fallback
      }
    }
    router.push(url);
    onMobileClose?.();
  };

  const toggleExpand = (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  if (collapsed) {
    return (
      <aside className={cn(
        "project-sidebar project-sidebar--collapsed flex flex-col h-full items-center py-2 gap-1 overflow-y-auto",
      )}>
        {projects.map((project) => {
          const workerSessions = sessionsByProject.get(project.id) ?? [];
          const visibleSessions = showDone ? workerSessions : workerSessions.filter(s => getAttentionLevel(s) !== "done");
          const projectAbbr = project.name.slice(0, 2).toUpperCase();
          return (
            <div key={project.id} className="flex flex-col items-center gap-0.5 w-full px-1">
              <a
                href={`/?project=${encodeURIComponent(project.id)}`}
                className={cn(
                  "project-sidebar__collapsed-icon",
                  activeProjectId === project.id && "project-sidebar__collapsed-icon--active",
                )}
                title={project.name}
                aria-label={project.name}
              >
                <span className="project-sidebar__collapsed-abbr">{projectAbbr}</span>
              </a>
              {visibleSessions.slice(0, 5).map((session) => {
                const level = getAttentionLevel(session);
                const title = session.branch ?? getSessionTitle(session);
                const abbr = title.slice(0, 3).toUpperCase();
                const isActive = activeSessionId === session.id;
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => navigate(`/sessions/${encodeURIComponent(session.id)}?project=${encodeURIComponent(project.id)}`)}
                    className={cn(
                      "project-sidebar__collapsed-session-btn",
                      isActive && "project-sidebar__collapsed-session-btn--active",
                    )}
                    data-level={level}
                    title={title}
                    aria-label={title}
                  >
                    <span className="project-sidebar__session-abbr-first">{abbr[0]}</span>
                    <span className="project-sidebar__session-abbr-rest">{abbr.slice(1)}</span>
                  </button>
                );
              })}
              {visibleSessions.length > 5 && (
                <span className="project-sidebar__collapsed-overflow">+{visibleSessions.length - 5}</span>
              )}
            </div>
          );
        })}
      </aside>
    );
  }

  return (
    <aside
      className="project-sidebar flex h-full flex-col"
    >
        <div className="project-sidebar__compact-hdr">
          <span className="project-sidebar__sect-label">Projects</span>
          <button type="button" className="project-sidebar__add-btn" aria-label="New project">
            <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

        {/* Stale-data banner: keep cached sessions visible on fetch failure but
            surface the error so users know the list may be out of date. */}
        {error && sessions && sessions.length > 0 ? (
          <div
            role="status"
            className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-[11px] text-[var(--color-text-tertiary)]"
          >
            <span>Failed to refresh · showing cached sessions</span>
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="font-medium text-[var(--color-link)] hover:underline"
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Project tree */}
        <div className="project-sidebar__tree flex-1 overflow-y-auto overflow-x-hidden">
          {projects.map((project) => {
            const workerSessions = sessionsByProject.get(project.id) ?? [];
            const isExpanded = expandedProjects.has(project.id);
            const isActive = activeProjectId === project.id;
            const visibleSessions = showDone ? workerSessions : workerSessions.filter(
              (s) => getAttentionLevel(s) !== "done",
            );
            const hasActiveSessions = visibleSessions.length > 0;

            const orchestratorSession = sessions.find(
              (s) => isOrchestratorSession(s, prefixByProject.get(s.projectId), allPrefixes) && s.projectId === project.id
            );

            return (
              <div key={project.id} className="project-sidebar__project">
                {/* Project row: toggle + action buttons */}
                <div className="project-sidebar__proj-row flex items-center">
                  {/* Project toggle */}
                  <button
                    type="button"
                    onClick={() => toggleExpand(project.id)}
                    className={cn(
                      "project-sidebar__proj-toggle",
                      isActive && "project-sidebar__proj-toggle--active",
                    )}
                    aria-expanded={isExpanded}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <svg
                      className={cn(
                        "project-sidebar__proj-chevron",
                        isExpanded && "project-sidebar__proj-chevron--open",
                      )}
                      width="10"
                      height="10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      viewBox="0 0 24 24"
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                    <span className="project-sidebar__proj-name">{project.name}</span>
                    <span
                      className={cn(
                        "project-sidebar__proj-badge",
                        hasActiveSessions && "project-sidebar__proj-badge--active",
                      )}
                    >
                      {workerSessions.length}
                    </span>
                  </button>

                  {/* Dashboard button */}
                  <a
                    href={`/?project=${encodeURIComponent(project.id)}`}
                    onClick={(e) => { e.stopPropagation(); onMobileClose?.(); }}
                    className="project-sidebar__proj-action"
                    aria-label={`Open ${project.name} dashboard`}
                    title="Dashboard"
                  >
                    <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-10h8V3h-8z" />
                    </svg>
                  </a>

                  {/* Orchestrator button */}
                  {orchestratorSession && (
                    <a
                      href={`/sessions/${encodeURIComponent(orchestratorSession.id)}?project=${encodeURIComponent(project.id)}`}
                      onClick={(e) => { e.stopPropagation(); onMobileClose?.(); }}
                      className="project-sidebar__proj-action"
                      aria-label={`Open ${project.name} orchestrator`}
                      title="Orchestrator"
                    >
                      <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <circle cx="12" cy="5" r="2" fill="currentColor" stroke="none" />
                        <path d="M12 7v4M12 11H6M12 11h6M6 11v3M12 11v3M18 11v3" />
                        <circle cx="6" cy="17" r="2" /><circle cx="12" cy="17" r="2" /><circle cx="18" cy="17" r="2" />
                      </svg>
                    </a>
                  )}
                </div>

                {/* Sessions */}
                {isExpanded && (
                  <div className="project-sidebar__sessions">
                    {isLoading ? (
                      <div className="space-y-2 px-3 py-2" aria-label="Loading sessions">
                        {Array.from({ length: 3 }, (_, index) => (
                          <div
                            key={`${project.id}-loading-${index}`}
                            className="flex items-center gap-3 rounded-lg px-2 py-2"
                          >
                            <div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--color-border-strong)]" />
                            <div className="h-3 flex-1 animate-pulse rounded bg-[var(--color-bg-primary)]" />
                            <div className="h-3 w-12 animate-pulse rounded bg-[var(--color-bg-primary)]" />
                          </div>
                        ))}
                      </div>
                    ) : visibleSessions.length > 0 ? (
                      visibleSessions.map((session) => {
                        const level = getAttentionLevel(session);
                        const isSessionActive = activeSessionId === session.id;
                        const title = session.branch ?? getSessionTitle(session);
                        return (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() =>
                              navigate(
                                `/sessions/${encodeURIComponent(session.id)}?project=${encodeURIComponent(project.id)}`,
                                session,
                              )
                            }
                            className={cn(
                              "project-sidebar__sess-row",
                              isSessionActive && "project-sidebar__sess-row--active",
                            )}
                            aria-current={isSessionActive ? "page" : undefined}
                            aria-label={`Open ${title}`}
                          >
                            <SessionDot level={level} />
                            <div className="flex-1 min-w-0">
                              <span
                                className={cn(
                                  "project-sidebar__sess-label",
                                  isSessionActive && "project-sidebar__sess-label--active",
                                )}
                              >
                                {title}
                              </span>
                              <div className="text-xs text-[var(--color-text-muted)]">
                                {session.id}
                              </div>
                            </div>
                            <span className="project-sidebar__sess-status">
                              {LEVEL_LABELS[level]}
                            </span>
                          </button>
                        );
                      })
                    ) : error ? (
                      <div className="px-3 py-2">
                        <div className="project-sidebar__empty">Failed to load sessions</div>
                        <button
                          type="button"
                          className="mt-2 text-xs font-medium text-[var(--color-link)] hover:underline"
                          onClick={onRetry}
                        >
                          Retry
                        </button>
                      </div>
                    ) : (
                      <div className="project-sidebar__empty">No active sessions</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="project-sidebar__footer">
          <div className="flex items-center gap-1 border-t border-[var(--color-border-subtle)] px-2 py-2">
            {/* Show killed toggle */}
            <button
              type="button"
              onClick={() => setShowKilled(!showKilled)}
              className={cn(
                "project-sidebar__footer-btn",
                showKilled && "project-sidebar__footer-btn--active",
              )}
              aria-pressed={showKilled}
              title={showKilled ? "Hide killed sessions" : "Show killed sessions"}
              aria-label={showKilled ? "Hide killed sessions" : "Show killed sessions"}
            >
              {/* skull / terminated icon */}
              <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3C7.03 3 3 7.03 3 12c0 3.1 1.5 5.84 3.8 7.55V21h2.4v-1h1.6v1h2.4v-1h1.6v1H17v-1.45A9 9 0 0 0 21 12c0-4.97-4.03-9-9-9z" />
                <circle cx="9" cy="11" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="15" cy="11" r="1.5" fill="currentColor" stroke="none" />
              </svg>
            </button>
            {/* Show done toggle */}
            <button
              type="button"
              onClick={() => setShowDone(!showDone)}
              className={cn(
                "project-sidebar__footer-btn",
                showDone && "project-sidebar__footer-btn--active",
              )}
              aria-pressed={showDone}
              title={showDone ? "Hide completed sessions" : "Show completed sessions"}
              aria-label={showDone ? "Hide completed sessions" : "Show completed sessions"}
            >
              {/* checkmark / done icon */}
              <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </button>
            <div className="flex-1" />
            <ThemeToggle className="project-sidebar__theme-toggle" />
          </div>
        </div>
    </aside>
  );
}
