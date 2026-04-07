"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";
import { getAttentionLevel, type DashboardSession } from "@/lib/types";
import { isOrchestratorSession } from "@composio/ao-core/types";
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
type ProjectHealth = "red" | "amber" | "green" | "done";

function SessionDot({ level }: { level: SessionDotLevel }) {
  return (
    <div
      className={cn(
        "sidebar-session-dot h-[5px] w-[5px] shrink-0 rounded-full",
        level === "respond" && "animate-[activity-pulse_2s_ease-in-out_infinite]",
      )}
      data-level={level}
    />
  );
}

function getProjectHealth(sessions: DashboardSession[]): ProjectHealth {
  if (sessions.length === 0) return "done";

  let hasAttention = false;
  let hasReviewLoad = false;

  for (const session of sessions) {
    const level = getAttentionLevel(session);
    if (level === "respond") return "red";
    if (level === "review" || level === "pending") {
      hasReviewLoad = true;
      continue;
    }
    if (level !== "done") hasAttention = true;
  }

  if (hasReviewLoad) return "amber";
  if (hasAttention) return "green";
  return "done";
}

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
  onToggleCollapsed,
  mobileOpen = false,
  onMobileClose,
}: ProjectSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();

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

  const CollapseChevron = ({ expanded }: { expanded: boolean }) => (
    <svg
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
    >
      {expanded ? <path d="M15 18l-6-6 6-6" /> : <path d="M9 18l6-6-6-6" />}
    </svg>
  );

  if (collapsed) {
    return (
      <>
        {mobileOpen && <div className="sidebar-mobile-backdrop" onClick={onMobileClose} />}
        <aside
          className={cn(
            "project-sidebar project-sidebar--collapsed flex h-full w-[40px] flex-col items-center pt-[10px]",
            mobileOpen && "project-sidebar--mobile-open",
          )}
        >
          <div className="project-sidebar__toggle-wrap project-sidebar__toggle-wrap--collapsed">
            <button
              type="button"
              onClick={() => {
                onToggleCollapsed?.();
                onMobileClose?.();
              }}
              className="project-sidebar__collapsed-toggle"
              aria-label="Expand sidebar"
            >
              <CollapseChevron expanded={false} />
            </button>
          </div>
        </aside>
      </>
    );
  }

  return (
    <>
      {mobileOpen && <div className="sidebar-mobile-backdrop" onClick={onMobileClose} />}
        <aside
          className={cn(
            "project-sidebar flex h-full w-[212px] flex-col",
            mobileOpen && "project-sidebar--mobile-open",
          )}
        >
        <div className="project-sidebar__toggle-wrap">
          <button
            type="button"
            onClick={() => {
              onToggleCollapsed?.();
              onMobileClose?.();
            }}
            className="project-sidebar__collapsed-toggle"
            aria-label="Collapse sidebar"
          >
            <CollapseChevron expanded={false} />
          </button>
        </div>
        <div className="project-sidebar__compact-hdr">
          <span className="project-sidebar__sect-label">Projects</span>
          <button type="button" className="project-sidebar__add-btn" aria-label="New project">
            <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

        {/* Project tree */}
        <div className="project-sidebar__tree flex-1 overflow-y-auto overflow-x-hidden pb-3">
          {projects.map((project, index) => {
            const workerSessions = sessionsByProject.get(project.id) ?? [];
            const isExpanded = expandedProjects.has(project.id);
            const isActive = activeProjectId === project.id;
            const visibleSessions = workerSessions.filter(
              (s) => getAttentionLevel(s) !== "done",
            );
            const projectHealth = getProjectHealth(visibleSessions);

            return (
              <div key={project.id}>
                <div
                  className={cn(
                    "project-sidebar__proj-block",
                    isExpanded
                      ? "project-sidebar__proj-block--expanded"
                      : "project-sidebar__proj-block--collapsed",
                  )}
                >
                  {/* Project row */}
                  <button
                    type="button"
                    onClick={() => {
                      toggleExpand(project.id);
                      navigate(`${pathname}?project=${encodeURIComponent(project.id)}`);
                    }}
                    className="project-sidebar__proj-row"
                    aria-expanded={isExpanded}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <span
                      className={cn(
                        "project-sidebar__proj-chevron",
                        isExpanded && "project-sidebar__proj-chevron--open",
                      )}
                    >
                      <svg
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                        className="h-[10px] w-[10px]"
                      >
                        {isExpanded ? <path d="M6 9l6 6 6-6" /> : <path d="M9 18l6-6-6-6" />}
                      </svg>
                    </span>
                    <div
                      className={cn(
                        "sidebar-health-dot h-[6px] w-[6px] shrink-0 rounded-full",
                        projectHealth === "red" && "animate-[activity-pulse_2s_ease-in-out_infinite]",
                      )}
                      data-health={projectHealth}
                    />
                    <span
                      className={cn(
                        "project-sidebar__proj-name",
                        !isActive && "project-sidebar__proj-name--dim",
                        projectHealth === "red" && "project-sidebar__proj-name--attn",
                        projectHealth === "done" && "project-sidebar__proj-name--idle",
                      )}
                    >
                      {project.name}
                    </span>
                    {workerSessions.length > 0 && (
                      <span
                        className={cn(
                          "project-sidebar__proj-count",
                          projectHealth === "red" && "project-sidebar__proj-count--attn",
                        )}
                      >
                        {workerSessions.length}
                      </span>
                    )}
                  </button>

                  {/* Sessions */}
                  {isExpanded && visibleSessions.length > 0 && (
                    <div>
                      {visibleSessions.map((session) => {
                        const level = getAttentionLevel(session);
                        const isSessionActive = activeSessionId === session.id;
                        const title = session.branch ?? getSessionTitle(session);
                        return (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() =>
                              navigate(
                                `${pathname}?project=${encodeURIComponent(project.id)}&session=${encodeURIComponent(session.id)}`,
                              )
                            }
                            className={cn(
                              "project-sidebar__sess",
                              isSessionActive && "project-sidebar__sess--active",
                            )}
                            aria-current={isSessionActive ? "page" : undefined}
                            aria-label={`Open ${title}`}
                          >
                            <SessionDot level={level} />
                            <span className="project-sidebar__sess-branch">{title}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {index < projects.length - 1 ? <div className="project-sidebar__proj-sep" /> : null}
              </div>
            );
          })}
        </div>
        <div className="project-sidebar__footer">
          <ThemeToggle className="project-sidebar__footer-btn" />
        </div>
      </aside>
    </>
  );
}
