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
  mobileOpen = false,
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

  const navigate = (url: string) => {
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
      <>
        {mobileOpen && <div className="sidebar-mobile-backdrop" onClick={onMobileClose} />}
        <aside
          className={cn(
            "project-sidebar project-sidebar--collapsed flex h-full flex-col",
            mobileOpen && "project-sidebar--mobile-open",
          )}
        />
      </>
    );
  }

  return (
    <>
      {mobileOpen && <div className="sidebar-mobile-backdrop" onClick={onMobileClose} />}
      <aside
        className={cn(
          "project-sidebar flex h-full flex-col",
          mobileOpen && "project-sidebar--mobile-open",
        )}
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
            const visibleSessions = workerSessions.filter(
              (s) => getAttentionLevel(s) !== "done",
            );
            const hasActiveSessions = visibleSessions.length > 0;

            return (
              <div key={project.id} className="project-sidebar__project">
                {/* Project toggle */}
                <button
                  type="button"
                  onClick={() => {
                    toggleExpand(project.id);
                    navigate(`/?project=${encodeURIComponent(project.id)}`);
                  }}
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
                                ao-{session.id.slice(0, 6)}
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
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-secondary)]">
            <button
              type="button"
              onClick={() => setShowKilled(!showKilled)}
              className={cn(
                "px-2 py-1 rounded text-xs transition-colors",
                showKilled
                  ? "bg-[var(--color-accent)] text-white"
                  : "hover:bg-[var(--color-bg-hover)]",
              )}
              aria-pressed={showKilled}
            >
              Show killed
            </button>
            <button
              type="button"
              onClick={() => setShowDone(!showDone)}
              className={cn(
                "px-2 py-1 rounded text-xs transition-colors",
                showDone
                  ? "bg-[var(--color-accent)] text-white"
                  : "hover:bg-[var(--color-bg-hover)]",
              )}
              aria-pressed={showDone}
            >
              Show done
            </button>
          </div>
          <div className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] px-3 py-2">
            <ThemeToggle className="project-sidebar__theme-toggle" />
            <span className="project-sidebar__theme-label">Theme</span>
          </div>
        </div>
      </aside>
    </>
  );
}
