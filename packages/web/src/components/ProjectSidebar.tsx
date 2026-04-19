"use client";

import Link from "next/link";
import { useState, useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";
import { getAttentionLevel, type DashboardSession, type AttentionLevel } from "@/lib/types";
import { isOrchestratorSession } from "@aoagents/ao-core/types";
import { getSessionTitle } from "@/lib/format";
import { getProjectColorIndex } from "@/lib/project-color";
import { getProjectSessionHref } from "@/lib/project-utils";
import { ThemeToggle } from "./ThemeToggle";

const EXPANDED_STORAGE_KEY = "ao.sidebar.projects.expanded";
const AGENT_MENU_WIDTH = 240;
const AGENT_MENU_GAP = 8;
const AGENT_MENU_VIEWPORT_MARGIN = 12;

function loadExpandedProjects(fallback: string[]): Set<string> {
  if (typeof window === "undefined") return new Set(fallback);
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (!raw) return new Set(fallback);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(fallback);
    return new Set([...parsed.filter((v): v is string => typeof v === "string"), ...fallback]);
  } catch {
    return new Set(fallback);
  }
}

function getProjectHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

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
  /** When provided, the existing "+" header button opens the add-project flow. */
  onAddProject?: () => void;
  /** When provided, shows a project row overflow menu with workspace actions. */
  onRemoveProject?: (projectId: string) => void;
}

interface AvailableAgent {
  id: string;
  name: string;
}

type SessionDotLevel =
  | "respond"
  | "review"
  | "action"
  | "pending"
  | "working"
  | "merge"
  | "done";

function getAgentTone(agent: AvailableAgent): string {
  const key = `${agent.id} ${agent.name}`.toLowerCase();
  if (key.includes("claude")) return "claude";
  if (key.includes("codex")) return "codex";
  if (key.includes("cursor")) return "cursor";
  if (key.includes("aider")) return "aider";
  if (key.includes("amp")) return "amp";
  if (key.includes("droid")) return "droid";
  if (key.includes("open")) return "opencode";
  return "generic";
}

function getAgentIconSrc(agent: AvailableAgent): string | null {
  const tone = getAgentTone(agent);
  if (tone === "claude") return "/agent-icons/claude-code.png";
  if (tone === "codex") return "/agent-icons/codex.svg";
  if (tone === "opencode") return "/agent-icons/opencode.png";
  return null;
}

function AgentGlyph({ agent }: { agent: AvailableAgent }) {
  const tone = getAgentTone(agent);
  const iconSrc = getAgentIconSrc(agent);
  const fallbackLabel = agent.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <span className="project-sidebar__agent-icon" data-agent-tone={tone} aria-hidden="true">
      {iconSrc ? (
        <img
          src={iconSrc}
          alt=""
          className="project-sidebar__agent-icon-image"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="project-sidebar__agent-icon-fallback">{fallbackLabel}</span>
      )}
    </span>
  );
}

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
  onAddProject,
  onRemoveProject,
}: ProjectSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const isLoading = loading || sessions === null;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const expandedProjectsHydratedRef = useRef(false);
  const initialExpandedProjects = useMemo(
    () => (activeProjectId && activeProjectId !== "all" ? [activeProjectId] : []),
    [activeProjectId],
  );

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() =>
    new Set(initialExpandedProjects),
  );
  const [agentMenuProjectId, setAgentMenuProjectId] = useState<string | null>(null);
  const [agentMenuPosition, setAgentMenuPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [projectMenuProjectId, setProjectMenuProjectId] = useState<string | null>(null);
  const [projectMenuPosition, setProjectMenuPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [availableAgents, setAvailableAgents] = useState<AvailableAgent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [spawningAgentKey, setSpawningAgentKey] = useState<string | null>(null);

  useEffect(() => {
    if (expandedProjectsHydratedRef.current) return;
    expandedProjectsHydratedRef.current = true;
    setExpandedProjects(loadExpandedProjects(initialExpandedProjects));
  }, [initialExpandedProjects]);

  useEffect(() => {
    if (activeProjectId && activeProjectId !== "all") {
      setExpandedProjects((prev) => new Set([...prev, activeProjectId]));
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...expandedProjects]));
    } catch {
      // ignore storage quota or disabled storage
    }
  }, [expandedProjects]);

  useEffect(() => {
    if (!agentMenuProjectId && !projectMenuProjectId) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setAgentMenuProjectId(null);
        setAgentMenuPosition(null);
        setProjectMenuProjectId(null);
        setProjectMenuPosition(null);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [agentMenuProjectId, projectMenuProjectId]);

  useEffect(() => {
    if (!agentMenuProjectId && !projectMenuProjectId) return;

    const closeMenu = () => {
      setAgentMenuProjectId(null);
      setAgentMenuPosition(null);
      setProjectMenuProjectId(null);
      setProjectMenuPosition(null);
    };

    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [agentMenuProjectId, projectMenuProjectId]);

  useEffect(() => {
    if (!agentMenuProjectId || agentsLoaded || agentsLoading) return;

    let cancelled = false;
    setAgentsLoading(true);

    void fetch("/api/agents")
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { agents?: AvailableAgent[]; error?: string }
          | null;
        if (!response.ok) {
          throw new Error(body?.error || "Failed to load agents");
        }
        if (!cancelled) {
          setAvailableAgents(body?.agents ?? []);
          setAgentsError(null);
          setAgentsLoaded(true);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setAgentsError(err instanceof Error ? err.message : "Failed to load agents");
        }
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentMenuProjectId, agentsLoaded]);

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
    if (!sessions) return map;
    for (const s of sessions) {
      if (isOrchestratorSession(s, prefixByProject.get(s.projectId), allPrefixes)) continue;
      const list = map.get(s.projectId) ?? [];
      list.push(s);
      map.set(s.projectId, list);
    }
    return map;
  }, [sessions, prefixByProject, allPrefixes]);

  const navigate = (url: string) => {
    if (pathname === url) {
      onMobileClose?.();
      return;
    }
    router.push(url);
    onMobileClose?.();
  };

  const spawnAgent = async (project: ProjectInfo, agentId: string) => {
    if (project.degraded) {
      setAgentsError(project.degradedReason || `${project.name} has an unresolved config error`);
      return;
    }
    const spawnKey = `${project.id}:${agentId}`;
    setSpawningAgentKey(spawnKey);
    setAgentsError(null);
    try {
      const response = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, agent: agentId }),
      });
      const body = (await response.json().catch(() => null)) as
        | { session?: { id?: string }; error?: string }
        | null;
      if (!response.ok || !body?.session?.id) {
        throw new Error(body?.error || `Failed to spawn ${agentId}`);
      }
      setAgentMenuProjectId(null);
      setAgentMenuPosition(null);
      navigate(getProjectSessionHref(project.id, body.session.id));
    } catch (err) {
      setAgentsError(err instanceof Error ? err.message : "Failed to spawn agent");
    } finally {
      setSpawningAgentKey((current) => (current === spawnKey ? null : current));
    }
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
          {onAddProject ? (
            <button
              type="button"
              className="project-sidebar__add-btn"
              aria-label="New project"
              onClick={onAddProject}
            >
              <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          ) : null}
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
                <div
                  className={cn(
                    "project-sidebar__proj-toggle",
                    isActive && "project-sidebar__proj-toggle--active",
                  )}
                  data-project-color={isActive ? getProjectColorIndex(project.id) : undefined}
                >
                  <button
                    type="button"
                    onClick={() => toggleExpand(project.id)}
                    className="project-sidebar__proj-chevron-button"
                    aria-label={`${isExpanded ? "Collapse" : "Expand"} ${project.name} sessions`}
                    aria-expanded={isExpanded}
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
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      navigate(getProjectHref(project.id));
                    }}
                    className="project-sidebar__proj-main"
                    aria-current={isActive ? "page" : undefined}
                    aria-label={`Open ${project.name}`}
                  >
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
                  <div
                    className="project-sidebar__proj-actions"
                    ref={agentMenuProjectId === project.id || projectMenuProjectId === project.id ? menuRef : undefined}
                  >
                    <button
                      type="button"
                      className="project-sidebar__proj-add-agent"
                      aria-label="Spawn agent"
                      aria-haspopup="menu"
                      aria-expanded={agentMenuProjectId === project.id}
                      disabled={project.degraded}
                      onClick={(event) => {
                        if (project.degraded) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        setAgentMenuProjectId((current) => {
                          if (current === project.id) {
                            setAgentMenuPosition(null);
                            return null;
                          }

                          setAgentMenuPosition({
                            top: Math.max(
                              AGENT_MENU_VIEWPORT_MARGIN,
                              Math.min(
                                rect.top - 6,
                                window.innerHeight - 180 - AGENT_MENU_VIEWPORT_MARGIN,
                              ),
                            ),
                            left: Math.max(
                              AGENT_MENU_VIEWPORT_MARGIN,
                              Math.min(
                                rect.right + AGENT_MENU_GAP,
                                window.innerWidth - AGENT_MENU_WIDTH - AGENT_MENU_VIEWPORT_MARGIN,
                              ),
                            ),
                          });

                          return project.id;
                        });
                      }}
                      title={
                        project.degraded
                          ? project.degradedReason || `${project.name} has an unresolved config error`
                          : `Spawn agent for ${project.name}`
                      }
                    >
                      <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                    {onRemoveProject ? (
                      <button
                        type="button"
                        className="project-sidebar__proj-more"
                        aria-label={`Project options for ${project.name}`}
                        aria-haspopup="menu"
                        aria-expanded={projectMenuProjectId === project.id}
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          setProjectMenuProjectId((current) => {
                            if (current === project.id) {
                              setProjectMenuPosition(null);
                              return null;
                            }

                            setAgentMenuProjectId(null);
                            setAgentMenuPosition(null);
                            setProjectMenuPosition({
                              top: Math.max(
                                AGENT_MENU_VIEWPORT_MARGIN,
                                Math.min(
                                  rect.top - 6,
                                  window.innerHeight - 120 - AGENT_MENU_VIEWPORT_MARGIN,
                                ),
                              ),
                              left: Math.max(
                                AGENT_MENU_VIEWPORT_MARGIN,
                                Math.min(
                                  rect.right + AGENT_MENU_GAP,
                                  window.innerWidth - 220 - AGENT_MENU_VIEWPORT_MARGIN,
                                ),
                              ),
                            });

                            return project.id;
                          });
                        }}
                        title={`Project options for ${project.name}`}
                      >
                        <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none" />
                          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
                          <circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none" />
                        </svg>
                      </button>
                    ) : null}
                    {agentMenuProjectId === project.id ? (
                      <div
                        className="project-sidebar__agent-menu"
                        role="menu"
                        aria-label={`Available agents for ${project.name}`}
                        style={agentMenuPosition ?? undefined}
                      >
                        {agentsLoading ? (
                          <div className="project-sidebar__agent-menu-state">Loading agents...</div>
                        ) : agentsError ? (
                          <div className="project-sidebar__agent-menu-state project-sidebar__agent-menu-state--error">
                            {agentsError}
                          </div>
                        ) : availableAgents.length === 0 ? (
                          <div className="project-sidebar__agent-menu-state">No agents configured</div>
                        ) : (
                          availableAgents.map((agent) => {
                            const isSpawning = spawningAgentKey === `${project.id}:${agent.id}`;
                            return (
                              <button
                                key={agent.id}
                                type="button"
                                role="menuitem"
                                className="project-sidebar__agent-menu-item"
                                onClick={() => void spawnAgent(project, agent.id)}
                                disabled={spawningAgentKey !== null}
                              >
                                <span className="project-sidebar__agent-menu-item-main">
                                  <AgentGlyph agent={agent} />
                                  <span className="project-sidebar__agent-menu-item-copy">
                                    <span className="project-sidebar__agent-menu-item-label">
                                      {agent.name}
                                    </span>
                                    <span className="project-sidebar__agent-menu-item-meta">
                                      {agent.id}
                                    </span>
                                  </span>
                                </span>
                                <span className="project-sidebar__agent-menu-item-status">
                                  {isSpawning ? "Spawning..." : "Launch"}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    ) : null}
                    {projectMenuProjectId === project.id ? (
                      <div
                        className="project-sidebar__agent-menu project-sidebar__project-menu"
                        role="menu"
                        aria-label={`Project actions for ${project.name}`}
                        style={projectMenuPosition ?? undefined}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="project-sidebar__agent-menu-item project-sidebar__project-menu-item--danger"
                          onClick={() => {
                            setProjectMenuProjectId(null);
                            setProjectMenuPosition(null);
                            onRemoveProject(project.id);
                          }}
                        >
                          <span className="project-sidebar__agent-menu-item-main">
                            <span className="project-sidebar__agent-menu-item-copy">
                              <span className="project-sidebar__agent-menu-item-label">
                                Delete Workspace
                              </span>
                              <span className="project-sidebar__agent-menu-item-meta">
                                Removes {project.name} from AO only
                              </span>
                            </span>
                          </span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Sessions */}
                {isExpanded && (isLoading || error || visibleSessions.length > 0) ? (
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
                        const sessionHref = getProjectSessionHref(project.id, session.id);
                        return (
                          <Link
                            key={session.id}
                            href={sessionHref}
                            onClick={(event) => {
                              if (pathname === sessionHref) {
                                event.preventDefault();
                                onMobileClose?.();
                              }
                            }}
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
                          </Link>
                        );
                      })
                    ) : (
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
                    )}
                  </div>
                ) : null}
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
