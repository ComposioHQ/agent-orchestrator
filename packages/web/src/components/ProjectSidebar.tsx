"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";
import {
  getAttentionLevel,
  isKilledSession,
  type DashboardOrchestratorLink,
  type DashboardSession,
  type AttentionLevel,
} from "@/lib/types";
import { isOrchestratorSession } from "@composio/ao-core/types";
import { getSessionSidebarLabel, stripBranchHashPrefix } from "@/lib/format";
import { useShowKilledSessions } from "@/hooks/useShowKilledSessions";
import { useShowDoneSessions } from "@/hooks/useShowDoneSessions";
import { SpawnSessionModal } from "@/components/SpawnSessionModal";

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  sessions: DashboardSession[];
  orchestrators?: DashboardOrchestratorLink[];
  activeProjectId: string | undefined;
  activeSessionId: string | undefined;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

type ProjectHealth = "red" | "yellow" | "green" | "gray";

function sidebarSessionLevel(session: DashboardSession): AttentionLevel {
  return isKilledSession(session) ? "killed" : getAttentionLevel(session);
}

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
  killed: "var(--color-status-error)",
};

const sessionToneLabel: Record<AttentionLevel, string> = {
  merge: "merge",
  respond: "reply",
  review: "review",
  pending: "wait",
  working: "live",
  done: "done",
  killed: "killed",
};

function sidebarSessionRowVisible(
  session: DashboardSession,
  showKilled: boolean,
  showDone: boolean,
): boolean {
  if (isKilledSession(session)) return showKilled;
  if (getAttentionLevel(session) === "done") return showDone;
  return true;
}

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
  orchestrators = [],
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
  const [showKilled, setShowKilled] = useShowKilledSessions();
  const [showDone, setShowDone] = useShowDoneSessions();
  const [spawnModalProjectId, setSpawnModalProjectId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = filterWrapRef.current;
      if (el && !el.contains(e.target as Node)) setFilterOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [filterOpen]);

  const orchestratorByProject = useMemo(() => {
    const m = new Map<string, DashboardOrchestratorLink>();
    for (const o of orchestrators) {
      m.set(o.projectId, o);
    }
    return m;
  }, [orchestrators]);

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

  const filterWorkers = (workers: DashboardSession[]) =>
    workers.filter((s) => sidebarSessionRowVisible(s, showKilled, showDone));

  const filterPopover = (
    <div
      ref={filterWrapRef}
      className={cn("relative", filterOpen && "z-30")}
    >
      <button
        type="button"
        onClick={() => setFilterOpen((o) => !o)}
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded border border-[var(--color-border-subtle)] text-[var(--color-text-tertiary)] transition-colors hover:border-[var(--color-border-default)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
        aria-expanded={filterOpen}
        aria-haspopup="true"
        aria-label="Filter session list"
        title="Filter sessions"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
        </svg>
      </button>
      {filterOpen ? (
        <div
          className={cn(
            "absolute top-[calc(100%+4px)] z-40 w-[200px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] py-2 shadow-[0_12px_28px_rgba(0,0,0,0.2)]",
            collapsed ? "left-0" : "right-0",
          )}
          role="dialog"
          aria-label="Session filters"
        >
          <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            Visibility
          </div>
          <label className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
            <span>Show killed sessions</span>
            <button
              type="button"
              role="switch"
              aria-checked={showKilled}
              onClick={() => setShowKilled(!showKilled)}
              className={cn(
                "relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors",
                showKilled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border-strong)]",
              )}
            >
              <span
                className={cn(
                  "pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                  showKilled ? "translate-x-[1.125rem]" : "translate-x-0",
                )}
              />
            </button>
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
            <span>Show done sessions</span>
            <button
              type="button"
              role="switch"
              aria-checked={showDone}
              onClick={() => setShowDone(!showDone)}
              className={cn(
                "relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors",
                showDone ? "bg-[var(--color-accent)]" : "bg-[var(--color-border-strong)]",
              )}
            >
              <span
                className={cn(
                  "pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                  showDone ? "translate-x-[1.125rem]" : "translate-x-0",
                )}
              />
            </button>
          </label>
        </div>
      ) : null}
    </div>
  );

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

  const {
    totalWorkers: totalWorkerSessions,
    needsInput: needsInputCount,
    reviewLoad: reviewLoadCount,
  } = sessionsByProject;

  const spawnModal =
    spawnModalProjectId ? (
      <SpawnSessionModal
        projectId={spawnModalProjectId}
        open
        onClose={() => setSpawnModalProjectId(null)}
      />
    ) : null;

  if (collapsed) {
    return (
      <>
        <aside className="project-sidebar project-sidebar--collapsed flex h-full w-[56px] flex-col items-center py-2">
          <div className="mb-1 flex w-full shrink-0 justify-center px-1">{filterPopover}</div>
          <div className="flex flex-1 flex-col items-center gap-3 overflow-y-auto">
            {projects.map((project) => {
              const entry = sessionsByProject.map.get(project.id);
              const health = entry ? computeProjectHealth(entry.all) : ("gray" as ProjectHealth);
              const isActive = activeProjectId === project.id;
              const initial = project.name.charAt(0).toUpperCase();
              const workerSessions = filterWorkers(entry?.workers ?? []);
              return (
                <div key={project.id} className="flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      router.push(`${shellPath}?project=${encodeURIComponent(project.id)}`)
                    }
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
                        const level = sidebarSessionLevel(session);
                        const isSessionActive = effectiveActiveSessionId === session.id;
                        const title = getSessionSidebarLabel(session);
                        const displayTitle = stripBranchHashPrefix(title);
                        const abbr = displayTitle.slice(0, 3).toUpperCase();
                        return (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() =>
                              router.push(
                                `/sessions/${encodeURIComponent(session.id)}?project=${encodeURIComponent(project.id)}`,
                              )
                            }
                            className={cn(
                              "project-sidebar__collapsed-session-btn",
                              isSessionActive && "project-sidebar__collapsed-session-btn--active",
                              level === "respond" && "animate-[activity-pulse_2s_ease-in-out_infinite]",
                            )}
                            style={{ borderColor: sessionDotColor[level] }}
                            title={`${displayTitle} (${sessionToneLabel[level]})`}
                          >
                            <span className="project-sidebar__session-abbr-first">{abbr[0]}</span>
                            <span className="project-sidebar__session-abbr-rest">{abbr.slice(1)}</span>
                          </button>
                        );
                      })}
                      {workerSessions.length > 5 && (
                        <span
                          className="project-sidebar__collapsed-more"
                          title={`+${workerSessions.length - 5} more`}
                        >
                          +{workerSessions.length - 5}
                        </span>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setSpawnModalProjectId(project.id)}
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-dashed border-[var(--color-border-muted)] text-[12px] text-[var(--color-text-tertiary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    title="New session"
                    aria-label={`New session in ${project.name}`}
                  >
                    +
                  </button>
                </div>
              );
            })}
          </div>
        </aside>
        {spawnModal}
      </>
    );
  }

  return (
    <>
      <aside className="project-sidebar flex h-full w-[244px] flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            Projects
          </span>
          {filterPopover}
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
            type="button"
            onClick={() => router.push(`${shellPath}?project=all`)}
            className={cn(
              "project-sidebar__item mb-1 flex w-full cursor-pointer items-center gap-2 px-2.5 py-[9px] text-left text-[12px] font-medium transition-colors",
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
            const workerSessions = filterWorkers(entry?.workers ?? []);
            const health = computeProjectHealth(projectSessions);
            const isExpanded = expandedProjects.has(project.id);
            const isActive = activeProjectId === project.id;
            const orchestrator = orchestratorByProject.get(project.id) ?? null;
            const dashboardHref = `${shellPath}?project=${encodeURIComponent(project.id)}`;
            const orchHref = orchestrator
              ? `/sessions/${encodeURIComponent(orchestrator.id)}`
              : null;

            return (
              <div key={project.id} className="mb-0.5">
                <div className="flex w-full items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => toggleExpand(project.id)}
                    className={cn(
                      "project-sidebar__item flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-[9px] text-left text-[12px] font-medium transition-colors",
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
                  <a
                    href={dashboardHref}
                    onClick={(e) => e.stopPropagation()}
                    className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded border border-[var(--color-border-subtle)] text-[var(--color-text-tertiary)] transition-colors hover:border-[var(--color-border-default)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] hover:no-underline"
                    title="Open project dashboard"
                    aria-label={`${project.name} dashboard`}
                  >
                    <svg
                      className="h-3.5 w-3.5 opacity-70"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      viewBox="0 0 24 24"
                    >
                      <path d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                    </svg>
                  </a>
                  {orchHref ? (
                    <a
                      href={orchHref}
                      onClick={(e) => e.stopPropagation()}
                      className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded border border-[var(--color-border-subtle)] text-[var(--color-text-tertiary)] transition-colors hover:border-[var(--color-border-default)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] hover:no-underline"
                      title="Open project orchestrator"
                      aria-label={`${project.name} orchestrator`}
                    >
                      <svg
                        className="h-3.5 w-3.5 opacity-70"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        viewBox="0 0 24 24"
                      >
                        <path d="M12 3v18M5 9h14M5 15h8" />
                      </svg>
                    </a>
                  ) : (
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-dashed border-[var(--color-border-muted)] text-[10px] text-[var(--color-text-tertiary)] opacity-50"
                      title="No orchestrator session"
                    >
                      —
                    </span>
                  )}
                </div>

                {isExpanded && (
                  <div className="project-sidebar__children ml-3 py-0.5">
                    {workerSessions.map((session) => {
                      const level = sidebarSessionLevel(session);
                      const isSessionActive = effectiveActiveSessionId === session.id;
                      const title = getSessionSidebarLabel(session);
                      const primary = stripBranchHashPrefix(title);
                      const idShort = session.id.slice(0, 8);
                      return (
                        <div
                          key={session.id}
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            router.push(
                              `/sessions/${encodeURIComponent(session.id)}?project=${encodeURIComponent(project.id)}`,
                            )
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              router.push(
                                `/sessions/${encodeURIComponent(session.id)}?project=${encodeURIComponent(project.id)}`,
                              );
                            }
                          }}
                          className={cn(
                            "project-sidebar__session group flex w-full cursor-pointer items-start gap-2 py-[6px] pl-3 pr-2 transition-colors",
                            isSessionActive
                              ? "project-sidebar__session--active text-[var(--color-accent)]"
                              : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]",
                          )}
                        >
                          <SessionDot level={level} />
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-[11px]">{primary}</span>
                            <span
                              className="block truncate font-mono text-[9px] text-[var(--color-text-tertiary)]"
                              title={session.id}
                            >
                              {idShort}
                            </span>
                          </div>
                          <span className="project-sidebar__session-tone ml-auto shrink-0 pt-0.5 text-[10px] text-[var(--color-text-muted)]">
                            {sessionToneLabel[level]}
                          </span>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => setSpawnModalProjectId(project.id)}
                      className="mt-1 flex w-full cursor-pointer items-center gap-2 py-[6px] pl-3 pr-2 text-left text-[11px] font-medium text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-accent)]"
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
      </aside>
      {spawnModal}
    </>
  );
}
