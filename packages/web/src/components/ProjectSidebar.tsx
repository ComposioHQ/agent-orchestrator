"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";
import { getAttentionLevel, type DashboardSession, type AttentionLevel } from "@/lib/types";
import { isOrchestratorSession } from "@composio/ao-core/types";
import { getSessionTitle } from "@/lib/format";
import { useShowDone } from "@/hooks/useShowDone";
import { SpawnSessionModal } from "@/components/SpawnSessionModal";

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  sessions: DashboardSession[];
  activeProjectId: string | undefined;
  activeSessionId: string | undefined;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
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
  onToggleCollapsed: _onToggleCollapsed,
}: ProjectSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const routeSessionId = useMemo(() => {
    const matchShort = pathname.match(/^\/s\/([^/]+)$/);
    if (matchShort?.[1]) return decodeURIComponent(matchShort[1]);
    const matchLong = pathname.match(/^\/sessions\/([^/]+)$/);
    if (matchLong?.[1]) return decodeURIComponent(matchLong[1]);
    return undefined;
  }, [pathname]);
  const effectiveActiveSessionId = routeSessionId ?? activeSessionId;
  const shellPath = pathname.startsWith("/s/") || pathname.startsWith("/sessions/") ? "/" : pathname;

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(activeProjectId && activeProjectId !== "all" ? [activeProjectId] : []),
  );
  const [showDone] = useShowDone();
  const [spawnModalProjectId, setSpawnModalProjectId] = useState<string | null>(null);

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
    router.push(`${shellPath}?project=${encodeURIComponent(projectId)}`);
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
      <aside className="project-sidebar project-sidebar--collapsed flex h-full w-[56px] flex-col items-center py-3">
        <div className="flex flex-1 flex-col items-center gap-3 overflow-y-auto">
          {projects.map((project) => {
            const entry = sessionsByProject.map.get(project.id);
            const health = entry ? computeProjectHealth(entry.all) : ("gray" as ProjectHealth);
            const isActive = activeProjectId === project.id;
            const initial = project.name.charAt(0).toUpperCase();
            const workerSessions =
              entry?.workers.filter((s) => showDone || getAttentionLevel(s) !== "done") ?? [];
            return (
              <div key={project.id} className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={() => router.push(`${shellPath}?project=${encodeURIComponent(project.id)}`)}
                  className={cn(
                    "project-sidebar__collapsed-project",
                    isActive && "project-sidebar__collapsed-project--active",
                  )}
                  title={project.name}
                >
                  <span className="project-sidebar__avatar">{initial}</span>
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
                {workerSessions.length > 0 && (
                  <div className="project-sidebar__collapsed-sessions">
                    {workerSessions.slice(0, 5).map((session) => {
                      const level = getAttentionLevel(session);
                      const isSessionActive = effectiveActiveSessionId === session.id;
                      const title = getSessionTitle(session);
                      const abbr = title.slice(0, 3).toUpperCase();
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => router.push(`/sessions/${encodeURIComponent(session.id)}?project=${encodeURIComponent(project.id)}`)}
                          className={cn(
                            "project-sidebar__collapsed-session-btn",
                            isSessionActive && "project-sidebar__collapsed-session-btn--active",
                            level === "respond" && "animate-[activity-pulse_2s_ease-in-out_infinite]",
                          )}
                          style={{ borderColor: sessionDotColor[level] }}
                          title={`${title} (${sessionToneLabel[level]})`}
                        >
                          <span className="project-sidebar__session-abbr-first">{abbr[0]}</span>
                          <span className="project-sidebar__session-abbr-rest">{abbr.slice(1)}</span>
                        </button>
                      );
                    })}
                    {workerSessions.length > 5 && (
                      <span className="project-sidebar__collapsed-more" title={`+${workerSessions.length - 5} more`}>
                        +{workerSessions.length - 5}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
   <aside className="project-sidebar flex h-full w-[244px] flex-col">
     <div className="flex items-center border-b border-[var(--color-border-subtle)] px-3 py-1.5">
       <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
         Projects
       </span>
     </div>
     <div className="project-sidebar__header px-4 pb-3 pt-3">
       <div className="project-sidebar__title-row">
         <div>
           <h2 className="project-sidebar__title">Portfolio</h2>
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
          onClick={() => router.push(`${shellPath}?project=all`)}
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
          const workerSessions =
            entry?.workers.filter((s) => showDone || getAttentionLevel(s) !== "done") ?? [];
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

              {isExpanded && (
                <div className="project-sidebar__children ml-3 py-0.5">
                  {workerSessions.map((session) => {
                    const level = getAttentionLevel(session);
                    const isSessionActive = effectiveActiveSessionId === session.id;
                    const title = getSessionTitle(session);
                    return (
                      <div
                        key={session.id}
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          router.push(`/sessions/${encodeURIComponent(session.id)}?project=${encodeURIComponent(project.id)}`)
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            router.push(
                              `/sessions/${encodeURIComponent(session.id)}?project=${encodeURIComponent(project.id)}`,
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
                          href={`/sessions/${encodeURIComponent(session.id)}?view=classic`}
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                          title="Classic view"
                        >
                          📋
                        </a>
                        <a
                          href={`/sessions/${encodeURIComponent(session.id)}`}
                          onClick={(e) => e.stopPropagation()}
                          className="project-sidebar__session-id shrink-0 font-mono text-[9px] hover:underline"
                          title={session.id}
                        >
                          {session.id.slice(0, 8)}
                        </a>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setSpawnModalProjectId(project.id)}
                    className="mt-1 flex w-full items-center gap-2 py-[6px] pl-3 pr-2 text-left text-[11px] font-medium text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-accent)]"
                    title="Spawn new session"
                  >
                    <span className="flex h-5 w-5 items-center justify-center rounded border border-dashed border-[var(--color-border-muted)] text-[14px] leading-none">
                      +
                    </span>
                    New session
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </nav>
      {/* sidebar toggle moved to top bar */}
      {spawnModalProjectId ? (
        <SpawnSessionModal
          projectId={spawnModalProjectId}
          open
          onClose={() => setSpawnModalProjectId(null)}
        />
      ) : null}
    </aside>
  );
}
