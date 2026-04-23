"use client";

import { cn } from "@/lib/cn";
import { getSessionTitle, humanizeBranch } from "@/lib/format";
import { projectDashboardPath, projectSessionPath } from "@/lib/routes";
import { getAttentionLevel, type DashboardSession } from "@/lib/types";
import type { ProjectInfo } from "@/lib/project-name";

interface ProjectSidebarCollapsedProps {
  activeProjectId: string | undefined;
  activeSessionId: string | undefined;
  navigate: (url: string, session?: DashboardSession) => void;
  sessionsByProject: Map<string, DashboardSession[]>;
  visibleProjects: ProjectInfo[];
}

export function ProjectSidebarCollapsed({
  activeProjectId,
  activeSessionId,
  navigate,
  sessionsByProject,
  visibleProjects,
}: ProjectSidebarCollapsedProps) {
  return (
    <aside className="project-sidebar project-sidebar--collapsed flex h-full flex-col items-center gap-1 overflow-y-auto py-2">
      {visibleProjects.map((project, idx) => {
        const visibleSessions = sessionsByProject.get(project.id) ?? [];
        const projectAbbr = project.name.slice(0, 2).toUpperCase();

        return (
          <div key={project.id} className="flex w-full flex-col items-center gap-0.5 px-1">
            {idx > 0 ? <div className="project-sidebar__collapsed-divider" aria-hidden="true" /> : null}
            <a
              href={projectDashboardPath(project.id)}
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
              const rawTitle = session.branch ?? getSessionTitle(session);
              const displayTitle = session.branch ? humanizeBranch(session.branch) || rawTitle : rawTitle;
              const abbr = displayTitle.replace(/\s+/g, "").slice(0, 3).toUpperCase();
              const isActive = activeSessionId === session.id;
              const sessionHref = projectSessionPath(project.id, session.id);

              return (
                <a
                  key={session.id}
                  href={sessionHref}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
                    event.preventDefault();
                    navigate(sessionHref, session);
                  }}
                  className={cn(
                    "project-sidebar__collapsed-session-btn",
                    isActive && "project-sidebar__collapsed-session-btn--active",
                  )}
                  data-level={level}
                  title={rawTitle}
                  aria-label={rawTitle}
                >
                  <span className="project-sidebar__session-abbr-first">{abbr[0]}</span>
                  <span className="project-sidebar__session-abbr-rest">{abbr.slice(1)}</span>
                </a>
              );
            })}
            {visibleSessions.length > 5 ? (
              <span className="project-sidebar__collapsed-overflow">+{visibleSessions.length - 5}</span>
            ) : null}
          </div>
        );
      })}
    </aside>
  );
}
