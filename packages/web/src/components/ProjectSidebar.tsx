"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";
import { getAttentionLevel, type DashboardSession, type AttentionLevel } from "@/lib/types";
import { isOrchestratorSession } from "@composio/ao-core/types";
import { getSessionTitle } from "@/lib/format";
import { getProjectSessionHref } from "@/lib/project-utils";
import { ProjectAvatar } from "./ProjectAvatar";

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

type ProjectHealth = "red" | "yellow" | "green" | "gray";

function computeProjectHealth(sessions: DashboardSession[]): ProjectHealth {
  const workers = sessions.filter((s) => !isOrchestratorSession(s));
  if (workers.length === 0) return "gray";
  for (const s of workers) {
    if (getAttentionLevel(s) === "respond") return "red";
  }
  for (const s of workers) {
    const lvl = getAttentionLevel(s);
    if (lvl === "review" || lvl === "pending") return "yellow";
  }
  return "green";
}

const healthDotColor: Record<ProjectHealth, string> = {
  red: "var(--color-status-error)",
  yellow: "var(--color-status-attention)",
  green: "var(--color-status-ready)",
  gray: "var(--color-text-tertiary)",
};

const sessionDotColor: Record<AttentionLevel, string> = {
  merge: "var(--color-status-ready)",
  respond: "var(--color-status-error)",
  review: "var(--color-accent-orange)",
  pending: "var(--color-status-attention)",
  working: "var(--color-status-working)",
  done: "var(--color-text-tertiary)",
};

const sessionToneLabel: Record<AttentionLevel, string> = {
  merge: "merge",
  respond: "reply",
  review: "review",
  pending: "wait",
  working: "live",
  done: "done",
};

function SessionDot({ level }: { level: AttentionLevel }) {
  return (
    <div
      className={cn(
        "h-[7px] w-[7px] shrink-0 rounded-full",
        level === "respond" && "animate-[activity-pulse_2s_ease-in-out_infinite]",
      )}
      style={{ background: sessionDotColor[level] }}
    />
  );
}

function HealthDot({ health }: { health: ProjectHealth }) {
  return (
    <div
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        health === "red" && "animate-[activity-pulse_2s_ease-in-out_infinite]",
      )}
      style={{ background: healthDotColor[health] }}
    />
  );
}

export function ProjectSidebar(props: ProjectSidebarProps) {
  if (props.projects.length <= 1) {
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

  const handleProjectHeaderClick = (projectId: string) => {
    toggleExpand(projectId);
    router.push(pathname + `?project=${encodeURIComponent(projectId)}`);
  };

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, { all: DashboardSession[]; workers: DashboardSession[] }>();
    let totalWorkers = 0;
    let needsInput = 0;
    let reviewLoad = 0;

    for (const s of sessions) {
      let entry = map.get(s.projectId);
      if (!entry) {
        entry = { all: [], workers: [] };
        map.set(s.projectId, entry);
      }
      entry.all.push(s);
      if (!isOrchestratorSession(s)) {
        entry.workers.push(s);
        totalWorkers++;
      }
      const lvl = getAttentionLevel(s);
      if (lvl === "respond") needsInput++;
      if (lvl === "review" || lvl === "pending") reviewLoad++;
    }

    return { map, totalWorkers, needsInput, reviewLoad };
  }, [sessions]);

  const { totalWorkers: totalWorkerSessions, needsInput: needsInputCount, reviewLoad: reviewLoadCount } = sessionsByProject;

  if (collapsed) {
    return (
      <>
        {mobileOpen && (
          <div className="sidebar-mobile-backdrop" onClick={onMobileClose} />
        )}
        <aside className={cn("project-sidebar project-sidebar--collapsed flex h-full w-[56px] flex-col items-center py-3", mobileOpen && "project-sidebar--mobile-open")}>
          <div className="flex flex-1 flex-col items-center gap-2">
            {projects.map((project) => {
              const entry = sessionsByProject.map.get(project.id);
              const health = entry ? computeProjectHealth(entry.all) : ("gray" as ProjectHealth);
              const isActive = activeProjectId === project.id;
              return (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => router.push(pathname + `?project=${encodeURIComponent(project.id)}`)}
                  className={cn(
                    "project-sidebar__collapsed-project",
                    isActive && "project-sidebar__collapsed-project--active",
                  )}
                  title={project.name}
                >
                  <ProjectAvatar projectId={project.id} name={project.name} size={24} />
                  {health !== "gray" && (
                    <span
                      className={cn(
                        "project-sidebar__health-indicator",
                        health === "red" && "animate-[activity-pulse_2s_ease-in-out_infinite]",
                      )}
                      style={{ background: healthDotColor[health] }}
                    />
                  )}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => { onToggleCollapsed?.(); onMobileClose?.(); }}
            className="project-sidebar__collapsed-toggle mt-auto"
            aria-label="Show project sidebar"
          >
            <svg
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
              className="h-4 w-4"
            >
              <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
              <path d="M9 4.5v15M12 10l3 2-3 2" />
            </svg>
          </button>
        </aside>
      </>
    );
  }

  return (
    <>
      {mobileOpen && (
        <div className="sidebar-mobile-backdrop" onClick={onMobileClose} />
      )}
      <aside className={cn("project-sidebar flex h-full w-[244px] flex-col", mobileOpen && "project-sidebar--mobile-open")}>
      <div className="project-sidebar__header px-4 pb-3 pt-4">
        <div className="project-sidebar__eyebrow">Portfolio</div>
        <div className="project-sidebar__title-row">
          <div>
            <h2 className="project-sidebar__title">Projects</h2>
            <p className="project-sidebar__subtitle">Live project overview.</p>
          </div>
          <div className="project-sidebar__badge">{projects.length}</div>
        </div>
        <div className="project-sidebar__summary">
          <div className="project-sidebar__metric">
            <span className="project-sidebar__metric-value">{totalWorkerSessions}</span>
            <span className="project-sidebar__metric-label">active</span>
          </div>
          <div className="project-sidebar__metric">
            <span
              className="project-sidebar__metric-value"
              style={{ color: "var(--color-status-attention)" }}
            >
              {reviewLoadCount}
            </span>
            <span className="project-sidebar__metric-label">review</span>
          </div>
          <div className="project-sidebar__metric">
            <span
              className="project-sidebar__metric-value"
              style={{ color: "var(--color-status-error)" }}
            >
              {needsInputCount}
            </span>
            <span className="project-sidebar__metric-label">blocked</span>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        <button
          onClick={() => router.push(pathname + "?project=all")}
          className={cn(
            "project-sidebar__item mb-1 flex w-full items-center gap-2 px-2.5 py-[9px] text-left text-[12px] font-medium transition-colors",
            activeProjectId === undefined || activeProjectId === "all"
              ? "project-sidebar__item--active text-[var(--color-accent)]"
              : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
          )}
        >
          <svg
            className="h-3.5 w-3.5 shrink-0 opacity-50"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
          >
            <path d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
          </svg>
          All Projects
        </button>

        <div className="project-sidebar__divider mx-2 my-2" />

        {projects.map((project) => {
          const entry = sessionsByProject.map.get(project.id);
          const projectSessions = entry?.all ?? [];
          const workerSessions = entry?.workers ?? [];
          const health = computeProjectHealth(projectSessions);
          const isExpanded = expandedProjects.has(project.id);
          const isActive = activeProjectId === project.id;

          return (
            <div key={project.id} className="mb-0.5">
              {/* Project header */}
              <button
                onClick={() => handleProjectHeaderClick(project.id)}
                className={cn(
                  "project-sidebar__item flex w-full items-center gap-2 px-2.5 py-[9px] text-left text-[12px] font-medium transition-colors",
                  isActive
                    ? "project-sidebar__item--active text-[var(--color-accent)]"
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
                )}
              >
                <svg
                  className={cn(
                    "h-3 w-3 shrink-0 opacity-40 transition-transform duration-150",
                    isExpanded && "rotate-90",
                  )}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
                <HealthDot health={health} />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {workerSessions.length > 0 && (
                  <span className="project-sidebar__count shrink-0 px-1.5 py-px text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
                    {workerSessions.length}
                  </span>
                )}
              </button>

              {isExpanded && workerSessions.length > 0 && (
                <div className="project-sidebar__children ml-3 py-0.5">
                  {workerSessions.filter((s) => getAttentionLevel(s) !== "done").map((session) => {
                    const level = getAttentionLevel(session);
                    const isSessionActive = activeSessionId === session.id;
                    const title = getSessionTitle(session);
                    return (
                      <div
                        key={session.id}
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          router.push(
                            `${pathname}?project=${encodeURIComponent(project.id)}&session=${encodeURIComponent(session.id)}`,
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            router.push(
                              `${pathname}?project=${encodeURIComponent(project.id)}&session=${encodeURIComponent(session.id)}`,
                            );
                          }
                        }}
                        className={cn(
                          "project-sidebar__session group flex w-full cursor-pointer items-center gap-2 py-[6px] pl-3 pr-2 transition-colors",
                          isSessionActive
                            ? "project-sidebar__session--active text-[var(--color-accent)]"
                            : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]",
                        )}
                      >
                        <SessionDot level={level} />
                        <span className="min-w-0 flex-1 truncate text-[11px]">{title}</span>
                        <span className="project-sidebar__session-tone">
                          {sessionToneLabel[level]}
                        </span>
                        <a
                          href={getProjectSessionHref(project.id, session.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="project-sidebar__session-id shrink-0 font-mono text-[9px] hover:underline"
                          title={session.id}
                        >
                          {session.id.slice(0, 8)}
                        </a>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="border-t border-[var(--color-border-subtle)] p-2">
        <button type="button" onClick={() => { onToggleCollapsed?.(); onMobileClose?.(); }} className="project-sidebar__collapse-btn">
          <svg
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
          >
            <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
            <path d="M9 4.5v15M15 10l-3 2 3 2" />
          </svg>
          Hide sidebar
        </button>
      </div>
    </aside>
    </>
  );
}
