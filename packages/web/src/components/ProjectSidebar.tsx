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
  sessions: DashboardSession[];
  activeProjectId: string | undefined;
  activeSessionId: string | undefined;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

type SessionDotLevel = "respond" | "review" | "pending" | "working" | "merge" | "done";

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

const LEVEL_LABELS: Record<AttentionLevel, string> = {
  working: "working",
  pending: "pending",
  review: "review",
  respond: "respond",
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
  collapsed = false,
  onToggleCollapsed: _onToggleCollapsed,
  mobileOpen = false,
  onMobileClose,
}: ProjectSidebarProps) {
  const router = useRouter();

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(activeProjectId && activeProjectId !== "all" ? [activeProjectId] : []),
  );

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
    for (const s of sessions) {
      if (isOrchestratorSession(s, prefixByProject.get(s.projectId), allPrefixes)) continue;
      const list = map.get(s.projectId) ?? [];
      list.push(s);
      map.set(s.projectId, list);
    }
    return map;
  }, [sessions, prefixByProject, allPrefixes]);

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
                    {visibleSessions.length > 0 ? (
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
                            <span
                              className={cn(
                                "project-sidebar__sess-label",
                                isSessionActive && "project-sidebar__sess-label--active",
                              )}
                            >
                              {title}
                            </span>
                            <span className="project-sidebar__sess-status">
                              {LEVEL_LABELS[level]}
                            </span>
                          </button>
                        );
                      })
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
          <ThemeToggle className="project-sidebar__theme-toggle" />
          <span className="project-sidebar__theme-label">Theme</span>
        </div>
      </aside>
    </>
  );
}
