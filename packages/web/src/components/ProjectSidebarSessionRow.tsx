"use client";

import { cn } from "@/lib/cn";
import { getSessionTitle } from "@/lib/format";
import { projectSessionPath } from "@/lib/routes";
import { getAttentionLevel, type DashboardSession } from "@/lib/types";

import { LEVEL_LABELS } from "./ProjectSidebar.shared";

function SessionDot({ level }: { level: ReturnType<typeof getAttentionLevel> }) {
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

interface ProjectSidebarSessionRowProps {
  activeSessionId: string | undefined;
  navigate: (url: string, session?: DashboardSession) => void;
  projectId: string;
  session: DashboardSession;
  showSessionId: boolean;
}

export function ProjectSidebarSessionRow({
  activeSessionId,
  navigate,
  projectId,
  session,
  showSessionId,
}: ProjectSidebarSessionRowProps) {
  const level = getAttentionLevel(session);
  const isSessionActive = activeSessionId === session.id;
  const title = session.branch ?? getSessionTitle(session);
  const sessionHref = projectSessionPath(projectId, session.id);

  return (
    <a
      href={sessionHref}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
        event.preventDefault();
        navigate(sessionHref, session);
      }}
      className={cn(
        "project-sidebar__sess-row",
        isSessionActive && "project-sidebar__sess-row--active",
      )}
      aria-current={isSessionActive ? "page" : undefined}
      aria-label={`Open ${title}`}
    >
      <SessionDot level={level} />
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "project-sidebar__sess-label",
            isSessionActive && "project-sidebar__sess-label--active",
          )}
        >
          {title}
        </span>
        {showSessionId ? (
          <div className="project-sidebar__sess-meta">
            <span className="project-sidebar__sess-id">{session.id}</span>
            <span className="project-sidebar__sess-status">{LEVEL_LABELS[level]}</span>
          </div>
        ) : null}
      </div>
      {!showSessionId ? (
        <span className="project-sidebar__sess-status project-sidebar__sess-status--inline">
          {LEVEL_LABELS[level]}
        </span>
      ) : null}
    </a>
  );
}
