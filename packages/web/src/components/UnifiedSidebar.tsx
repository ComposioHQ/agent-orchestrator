"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { getAttentionLevel, type AttentionLevel, type DashboardSession, type PortfolioProjectSummary } from "@/lib/types";
import { getProjectSessionHref } from "@/lib/project-utils";
import { getSessionTitle } from "@/lib/format";
import { isOrchestratorSession } from "@composio/ao-core/types";
import { Modal } from "./Modal";
import { ThemeToggle } from "./ThemeToggle";
import { WorkspaceResourcesModal } from "./WorkspaceResourcesModal";
import { ProjectAvatar } from "./ProjectAvatar";

interface UnifiedSidebarProps {
  projects: PortfolioProjectSummary[];
  sessions?: DashboardSession[];
  activeProjectId?: string;
  activeSessionId?: string;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  onAddProject?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  width?: number;
  onWidthChange?: (width: number) => void;
}

const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 400;

const PROJECT_SWATCHES = [
  "#cf73c9",
  "#e49a4b",
  "#7b8df1",
  "#53b49f",
  "#c95f67",
  "#8e79d9",
] as const;

const FOCUSABLE =
  'a[href], button:not(:disabled), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function projectSwatch(project: PortfolioProjectSummary, index: number) {
  if (project.degraded) return "transparent";
  return PROJECT_SWATCHES[index % PROJECT_SWATCHES.length];
}

function reorderProjects(
  projects: PortfolioProjectSummary[],
  draggedProjectId: string,
  targetProjectId: string,
): PortfolioProjectSummary[] {
  if (draggedProjectId === targetProjectId) return projects;

  const fromIndex = projects.findIndex((project) => project.id === draggedProjectId);
  const targetIndex = projects.findIndex((project) => project.id === targetProjectId);
  if (fromIndex === -1 || targetIndex === -1) return projects;

  const next = [...projects];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

function formatAgentLabel(agentId: string | undefined): string {
  switch (agentId) {
    case "claude-code":
      return "Claude";
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
    default:
      return agentId
        ? agentId.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
        : "Agent";
  }
}

function getAgentIconProps(agentId: string | undefined): { src?: string; fallback: string } {
  switch (agentId) {
    case "claude-code":
      return { src: "/agent-icons/claude-code.png", fallback: "CC" };
    case "opencode":
      return { src: "/agent-icons/opencode.png", fallback: "OC" };
    case "codex":
      return { src: "/agent-icons/codex.svg", fallback: "CX" };
    default: {
      const fallback = formatAgentLabel(agentId)
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase() || "AG";
      return { fallback };
    }
  }
}

function SidebarContent({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  onAddProject,
}: {
  projects: PortfolioProjectSummary[];
  sessions?: DashboardSession[];
  activeProjectId?: string;
  activeSessionId?: string;
  onAddProject?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const isHome = pathname === "/" || pathname === "/activity";
  const [availableAgents, setAvailableAgents] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<"repo" | "status">("repo");
  const [repoFilter, setRepoFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [openFilter, setOpenFilter] = useState<null | "groupBy" | "repo" | "status">(null);
  const [resourceProject, setResourceProject] = useState<PortfolioProjectSummary | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [killTarget, setKillTarget] = useState<{ id: string; title: string } | null>(null);
  const [killing, setKilling] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [spawnMenuProjectId, setSpawnMenuProjectId] = useState<string | null>(null);
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [orderedProjects, setOrderedProjects] = useState(projects);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(activeProjectId ? [activeProjectId] : []),
  );
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const spawnMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  const sortedProjects = useMemo(
    () => [...orderedProjects].sort((a, b) => a.name.localeCompare(b.name)),
    [orderedProjects],
  );

  const visibleProjects = useMemo(() => {
    let filtered = groupBy === "repo" && repoFilter === "all" ? orderedProjects : sortedProjects;
    if (groupBy === "repo" && repoFilter !== "all") {
      filtered = sortedProjects.filter((project) => project.id === repoFilter);
    }
    if (groupBy === "status" && statusFilter !== "all") {
      filtered = filtered.filter((project) => {
        if (statusFilter === "active") return project.activeCount > 0;
        if (statusFilter === "respond") return project.attentionCounts.respond > 0;
        if (statusFilter === "review") return project.attentionCounts.review > 0;
        return project.activeCount === 0;
      });
    }
    return filtered;
  }, [groupBy, orderedProjects, repoFilter, sortedProjects, statusFilter]);

  const canReorderWorkspaces = groupBy === "repo" && repoFilter === "all";

  const activeAgents = useMemo(() => {
    if (!sessions) return [];
    return sessions
      .filter((s) => {
        if (isOrchestratorSession(s)) return false;
        const level = getAttentionLevel(s);
        return level !== "done";
      })
      .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
  }, [sessions]);

  const activeAgentsByProject = useMemo(() => {
    const grouped = new Map<string, DashboardSession[]>();
    for (const session of activeAgents) {
      const projectSessions = grouped.get(session.projectId) ?? [];
      projectSessions.push(session);
      grouped.set(session.projectId, projectSessions);
    }
    return grouped;
  }, [activeAgents]);

  useEffect(() => {
    setOrderedProjects(projects);
  }, [projects]);

  useEffect(() => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (activeProjectId) {
        next.add(activeProjectId);
      }
      if (activeSessionId) {
        const activeSessionProjectId = sessions?.find((session) => session.id === activeSessionId)?.projectId;
        if (activeSessionProjectId) {
          next.add(activeSessionProjectId);
        }
      }
      return next;
    });
  }, [activeProjectId, activeSessionId, sessions]);

  const spawnAgents = useMemo(
    () =>
      [
        {
          id: "opencode",
          label: "Open Code",
          icon: <AgentFaviconIcon src="/agent-icons/opencode.png" fallback="OC" />,
        },
        {
          id: "claude-code",
          label: "Claude Code",
          icon: <AgentFaviconIcon src="/agent-icons/claude-code.png" fallback="CC" />,
        },
        {
          id: "codex",
          label: "Codex",
          icon: <AgentFaviconIcon src="/agent-icons/codex.svg" fallback="CX" />,
        },
      ].filter((agent) => availableAgents.includes(agent.id)),
    [availableAgents],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadAvailableAgents() {
      try {
        const res = await fetch("/api/agents");
        const body = (await res.json().catch(() => null)) as
          | { agents?: Array<{ id?: string }> }
          | null;
        if (!res.ok || !body?.agents || cancelled) return;
        setAvailableAgents(
          body.agents
            .map((agent) => (typeof agent.id === "string" ? agent.id : null))
            .filter((agent): agent is string => Boolean(agent)),
        );
      } catch {
        // Ignore availability fetch failures; the menu will simply show no agent options.
      }
    }

    void loadAvailableAgents();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleFilterPointerDown(event: PointerEvent) {
      if (!filterMenuRef.current?.contains(event.target as Node)) {
        setShowFilterMenu(false);
        setOpenFilter(null);
      }
    }

    if (!showFilterMenu) return;
    document.addEventListener("pointerdown", handleFilterPointerDown);
    return () => document.removeEventListener("pointerdown", handleFilterPointerDown);
  }, [showFilterMenu]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!addMenuRef.current?.contains(event.target as Node)) {
        setShowAddMenu(false);
      }
    }

    if (!showAddMenu) return;
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [showAddMenu]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!spawnMenuRef.current?.contains(event.target as Node)) {
        setSpawnMenuProjectId(null);
      }
    }

    if (!spawnMenuProjectId) return;
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [spawnMenuProjectId]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!projectMenuRef.current?.contains(event.target as Node)) {
        setProjectMenuId(null);
      }
    }

    if (!projectMenuId) return;
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [projectMenuId]);

  function handleRemoveProject(projectId: string, projectName: string) {
    setRemoveTarget({ id: projectId, name: projectName });
  }

  async function executeRemoveProject() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      const projectId = removeTarget.id;
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Failed to remove project");
      }
      setRemoveTarget(null);
      const viewingDeletedProject =
        activeProjectId === projectId || pathname.startsWith(`/projects/${encodeURIComponent(projectId)}`);
      if (viewingDeletedProject) {
        router.push("/");
      }
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to remove project");
    } finally {
      setRemoving(false);
    }
  }

  async function handleSpawnAgent(projectId: string, agent?: string) {
    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, ...(agent ? { agent } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; session?: { id: string } }
        | null;
      if (!res.ok || !body?.session?.id) {
        throw new Error(body?.error || "Failed to spawn agent");
      }
      router.push(getProjectSessionHref(projectId, body.session.id));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to spawn agent");
    }
  }

  function handleKillSession(sessionId: string, sessionTitle: string) {
    setKillTarget({ id: sessionId, title: sessionTitle });
  }

  async function executeKillSession() {
    if (!killTarget) return;
    setKilling(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(killTarget.id)}/kill`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Failed to terminate session");
      }
      setKillTarget(null);
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to terminate session");
    } finally {
      setKilling(false);
    }
  }

  async function persistProjectOrder(nextProjects: PortfolioProjectSummary[]) {
    const previousProjects = orderedProjects;
    setOrderedProjects(nextProjects);

    try {
      const res = await fetch("/api/settings/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectOrder: nextProjects.map((project) => project.id) }),
      });

      if (!res.ok) {
        throw new Error("Failed to save workspace order");
      }
      router.refresh();
    } catch (error) {
      console.error(error);
      setOrderedProjects(previousProjects);
    }
  }

  function handleProjectDragStart(event: DragEvent<HTMLDivElement>, projectId: string) {
    if (!canReorderWorkspaces) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", projectId);
    setDraggedProjectId(projectId);
    setDragOverProjectId(projectId);
  }

  function handleProjectDragOver(event: DragEvent<HTMLDivElement>, projectId: string) {
    if (!canReorderWorkspaces || !draggedProjectId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dragOverProjectId !== projectId) {
      setDragOverProjectId(projectId);
    }
  }

  function handleProjectDragEnd() {
    setDraggedProjectId(null);
    setDragOverProjectId(null);
  }

  function handleProjectDrop(projectId: string) {
    if (!canReorderWorkspaces || !draggedProjectId) return;
    const nextProjects = reorderProjects(orderedProjects, draggedProjectId, projectId);
    handleProjectDragEnd();
    if (nextProjects !== orderedProjects) {
      void persistProjectOrder(nextProjects);
    }
  }

  function toggleProjectExpanded(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-surface)] text-[var(--color-text-secondary)]">
      {/* Activity link */}
      <div className="border-b border-[var(--color-border-subtle)] px-3 py-2.5">
        <Link
          href="/activity"
          className={cn(
            "flex items-center gap-2 text-[13px] font-medium tracking-[-0.011em] transition-colors duration-100 hover:no-underline",
            isHome
              ? "text-[var(--color-text-primary)]"
              : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
          )}
        >
          <ClockIcon />
          <span>Activity</span>
        </Link>
      </div>

      {/* Workspaces header */}
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="font-[family-name:var(--font-mono)] text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
          Workspaces
        </span>
        <div className="flex items-center gap-1 text-[var(--color-text-tertiary)]">
          <div ref={filterMenuRef}>
            <Tooltip label="Filter workspaces">
              <button
                type="button"
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated-hover)] hover:text-[var(--color-text-secondary)]"
                aria-label="Workspace filters"
                onClick={() => {
                  setShowFilterMenu((value) => !value);
                  setOpenFilter(null);
                }}
              >
                <SortIcon />
              </button>
            </Tooltip>
            {showFilterMenu ? (
              <div className="fixed left-3 z-20 mt-2 w-[230px] rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-3 shadow-[var(--box-shadow-lg,0_14px_40px_rgba(0,0,0,0.18))]">
                <div className="grid gap-4">
                  <PopoverField
                    label="Group by"
                    valueLabel={groupBy === "repo" ? "Repo" : "Status"}
                    isOpen={openFilter === "groupBy"}
                    onToggle={() =>
                      setOpenFilter((value) => (value === "groupBy" ? null : "groupBy"))
                    }
                    onClose={() => setOpenFilter(null)}
                  >
                    <PopoverOption
                      label="Status"
                      selected={groupBy === "status"}
                      onSelect={() => {
                        setGroupBy("status");
                        setOpenFilter(null);
                      }}
                    />
                    <PopoverOption
                      label="Repo"
                      selected={groupBy === "repo"}
                      onSelect={() => {
                        setGroupBy("repo");
                        setOpenFilter(null);
                      }}
                    />
                  </PopoverField>

                  {groupBy === "repo" ? (
                    <PopoverField
                      label="Repo"
                      valueLabel={
                        repoFilter === "all"
                          ? "All repos"
                          : sortedProjects.find((project) => project.id === repoFilter)?.name ??
                            "All repos"
                      }
                      isOpen={openFilter === "repo"}
                      onToggle={() => setOpenFilter((value) => (value === "repo" ? null : "repo"))}
                      onClose={() => setOpenFilter(null)}
                    >
                      <PopoverOption
                        label="All repos"
                        selected={repoFilter === "all"}
                        onSelect={() => {
                          setRepoFilter("all");
                          setOpenFilter(null);
                          setShowFilterMenu(false);
                        }}
                      />
                      {sortedProjects.map((project, index) => (
                        <PopoverOption
                          key={project.id}
                          label={project.name}
                          selected={repoFilter === project.id}
                          swatch={projectSwatch(project, index)}
                          onSelect={() => {
                            setRepoFilter(project.id);
                            setOpenFilter(null);
                            setShowFilterMenu(false);
                          }}
                        />
                      ))}
                    </PopoverField>
                  ) : (
                    <PopoverField
                      label="Status"
                      valueLabel={
                        (
                          {
                            all: "All statuses",
                            active: "Active",
                            review: "Review",
                            respond: "Respond",
                            quiet: "Quiet",
                          } as const
                        )[statusFilter as "all" | "active" | "review" | "respond" | "quiet"]
                      }
                      isOpen={openFilter === "status"}
                      onToggle={() =>
                        setOpenFilter((value) => (value === "status" ? null : "status"))
                      }
                      onClose={() => setOpenFilter(null)}
                    >
                      {[
                        ["all", "All statuses"],
                        ["active", "Active"],
                        ["review", "Review"],
                        ["respond", "Respond"],
                        ["quiet", "Quiet"],
                      ].map(([value, label]) => (
                        <PopoverOption
                          key={value}
                          label={label}
                          selected={statusFilter === value}
                          onSelect={() => {
                            setStatusFilter(value);
                            setOpenFilter(null);
                            setShowFilterMenu(false);
                          }}
                        />
                      ))}
                    </PopoverField>
                  )}
                </div>
              </div>
            ) : null}
          </div>
          <div className="relative" ref={addMenuRef}>
          <Tooltip label="Add repository">
            <button
              type="button"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated-hover)] hover:text-[var(--color-text-secondary)]"
              aria-label="Add repository"
              onClick={() => setShowAddMenu((value) => !value)}
            >
              <FolderPlusIcon />
            </button>
          </Tooltip>
          {showAddMenu ? (
            <div className="absolute right-0 top-8 z-20 min-w-[164px] rounded-[var(--radius-lg)] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-1 shadow-[var(--box-shadow-lg,0_14px_40px_rgba(0,0,0,0.18))]">
              <SidebarMenuButton
                icon={<FolderOpenIcon />}
                label="Open project"
                onClick={() => {
                  setShowAddMenu(false);
                  onAddProject?.();
                }}
              />
            </div>
          ) : null}
        </div>
        </div>
      </div>

      {/* Workspace list */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-4" aria-label="Workspace navigation">
        <div className="space-y-0.5">
          {visibleProjects.map((project) => {
            const isActive = activeProjectId === project.id;
            const projectAgents = activeAgentsByProject.get(project.id) ?? [];
            const isExpanded = expandedProjectIds.has(project.id);
            const isDragTarget =
              canReorderWorkspaces &&
              draggedProjectId !== null &&
              draggedProjectId !== project.id &&
              dragOverProjectId === project.id;

            return (
              <div
                key={project.id}
                draggable={canReorderWorkspaces}
                data-testid={`workspace-row-${project.id}`}
                data-draggable={canReorderWorkspaces ? "true" : "false"}
                onDragStart={(event) => handleProjectDragStart(event, project.id)}
                onDragOver={(event) => handleProjectDragOver(event, project.id)}
                onDrop={(event) => {
                  event.preventDefault();
                  handleProjectDrop(project.id);
                }}
                onDragEnd={handleProjectDragEnd}
                className={cn(
                  "group/row relative rounded-[var(--radius-sm)] transition-colors duration-100",
                  isActive
                    ? "bg-[var(--color-accent-subtle)]"
                    : "hover:bg-[var(--color-bg-elevated-hover)]",
                  canReorderWorkspaces && "cursor-grab active:cursor-grabbing",
                  draggedProjectId === project.id && "opacity-70",
                  isDragTarget && "ring-1 ring-[var(--color-accent)] ring-inset",
                )}
              >
                {/* Active accent bar */}
                {isActive ? (
                  <span className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-[var(--color-accent)]" />
                ) : null}
                {canReorderWorkspaces ? (
                  <span
                    className={cn(
                      "pointer-events-none absolute left-0.5 top-1/2 z-[1] -translate-y-1/2 text-[var(--color-text-quaternary)] transition-all duration-100",
                      draggedProjectId === project.id
                        ? "opacity-100"
                        : "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
                    )}
                    aria-hidden="true"
                  >
                    <GripIcon />
                  </span>
                ) : null}

                <div className="flex min-h-[32px] items-center gap-1 px-1.5 py-1">
                  <div
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-1.5 text-[13px] tracking-[-0.011em]",
                      isActive
                        ? "text-[var(--color-text-primary)]"
                        : "text-[var(--color-text-secondary)]",
                    )}
                  >
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleProjectExpanded(project.id);
                      }}
                      aria-label={`${isExpanded ? "Collapse" : "Expand"} ${project.name} sessions`}
                      aria-expanded={isExpanded}
                      className="relative z-[3] flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-quaternary)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated-hover)] hover:text-[var(--color-text-tertiary)]"
                    >
                      <span className={cn("transition-transform duration-150", isExpanded && "rotate-90")}>
                        <ChevronRightIcon />
                      </span>
                    </button>
                    <Link
                      href={`/projects/${encodeURIComponent(project.id)}`}
                      draggable={false}
                      className="flex min-w-0 flex-1 items-center gap-2 hover:no-underline"
                    >
                      <ProjectAvatar
                        projectId={project.id}
                        name={project.name}
                        degraded={project.degraded}
                      />

                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.02em]">
                        {project.name}
                      </span>
                    </Link>
                  </div>

                  <div
                    className={cn(
                      "flex shrink-0 items-center gap-0.5 transition-opacity duration-100",
                      "opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100",
                    )}
                  >
                    <div className="relative" ref={projectMenuId === project.id ? projectMenuRef : undefined}>
                      <SidebarIconButton
                        label="Project options"
                        onClick={() => {
                          setProjectMenuId(
                            projectMenuId === project.id ? null : project.id,
                          );
                        }}
                      >
                        <MoreIcon />
                      </SidebarIconButton>
                      {projectMenuId === project.id ? (
                        <div className="absolute right-0 top-8 z-20 min-w-[192px] rounded-[var(--radius-lg)] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-1 shadow-[var(--box-shadow-lg,0_14px_40px_rgba(0,0,0,0.18))]">
                          <SidebarMenuButton
                            icon={<LinkIcon />}
                            label="Open from"
                            onClick={() => {
                              setProjectMenuId(null);
                              setResourceProject(project);
                            }}
                          />
                          <SidebarMenuButton
                            icon={<TrashIcon />}
                            label="Remove workspace"
                            onClick={() => {
                              setProjectMenuId(null);
                              handleRemoveProject(project.id, project.name);
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                    <div className="relative" ref={spawnMenuProjectId === project.id ? spawnMenuRef : undefined}>
                      <SidebarIconButton
                        label="Spawn a new agent"
                        onClick={() => {
                          setSpawnMenuProjectId(
                            spawnMenuProjectId === project.id ? null : project.id,
                          );
                        }}
                      >
                        <PlusIcon />
                      </SidebarIconButton>
                      {spawnMenuProjectId === project.id ? (
                        <div className="absolute right-0 top-8 z-20 min-w-[164px] rounded-[var(--radius-lg)] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-1 shadow-[var(--box-shadow-lg,0_14px_40px_rgba(0,0,0,0.18))]">
                          {spawnAgents.length > 0 ? (
                            spawnAgents.map((agent) => (
                              <SidebarMenuButton
                                key={agent.id}
                                icon={agent.icon}
                                label={agent.label}
                                onClick={() => {
                                  setSpawnMenuProjectId(null);
                                  void handleSpawnAgent(project.id, agent.id);
                                }}
                              />
                            ))
                          ) : (
                            <div className="px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
                              No available agents
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>

                {isExpanded ? (
                  <div draggable={false} className="pb-1.5 pl-3 pr-1">
                    <div className="space-y-0.5 border-l border-[var(--color-border-subtle)] pl-2.5">
                      {projectAgents.length > 0 ? (
                        projectAgents.map((session) => {
                          const isSessionActive = activeSessionId === session.id;
                          const attention = getAttentionLevel(session);
                          const title = getSessionTitle(session);

                          return (
                            <div
                              key={session.id}
                              className={cn(
                                "group/session relative flex items-center gap-1 overflow-hidden rounded-[var(--radius-sm)] border-l-2",
                                ATTENTION_BORDER_CLASS[attention],
                                isSessionActive
                                  ? "bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)]"
                                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated-hover)]",
                              )}
                            >
                              <Link
                                href={getProjectSessionHref(session.projectId, session.id)}
                                draggable={false}
                                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 pr-1 hover:no-underline"
                              >
                                <SidebarAgentIcon agentId={session.metadata["agent"]} attention={attention} />
                                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium tracking-[-0.011em]">
                                  {title}
                                </span>
                                <StatusChip attention={attention} />
                              </Link>
                              <div className="pr-1 opacity-0 transition-opacity duration-100 group-hover/session:opacity-100 group-focus-within/session:opacity-100">
                                <SidebarIconButton
                                  label="Terminate session"
                                  onClick={() => {
                                    handleKillSession(session.id, title);
                                  }}
                                >
                                  <TrashIcon />
                                </SidebarIconButton>
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <div className="py-1.5 pl-1.5 text-[11px] text-[var(--color-text-tertiary)]">
                          No agents
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </nav>

      {/* Footer */}
      <div className="border-t border-[var(--color-border-subtle)] px-3 py-2">
        <div className="flex items-center justify-between text-[var(--color-text-tertiary)]">
          <ThemeToggle compact />
          <Link
            href="/settings"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] text-[var(--color-text-tertiary)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated-hover)] hover:text-[var(--color-text-secondary)] hover:no-underline"
            aria-label="Open settings"
          >
            <GearIcon />
          </Link>
        </div>
      </div>

      <WorkspaceResourcesModal
        open={resourceProject !== null}
        onClose={() => setResourceProject(null)}
        project={
          resourceProject
            ? {
                id: resourceProject.id,
                name: resourceProject.name,
                repo: resourceProject.repo,
              }
            : null
        }
      />

      <Modal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title="Remove Workspace"
        size="sm"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setRemoveTarget(null)}
              disabled={removing}
              className="border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)] disabled:opacity-50"
              style={{ borderRadius: "2px", minHeight: 40 }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void executeRemoveProject(); }}
              disabled={removing}
              className="bg-[var(--color-status-error)] px-4 py-2 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ borderRadius: "2px", minHeight: 40 }}
            >
              {removing ? "Removing..." : "Remove"}
            </button>
          </div>
        }
      >
        <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          Remove{" "}
          <span
            className="font-medium text-[var(--color-text-primary)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {removeTarget?.name}
          </span>{" "}
          from your workspaces? The directory won&apos;t be deleted from disk.
        </p>
      </Modal>

      <Modal
        open={killTarget !== null}
        onClose={() => setKillTarget(null)}
        title="Terminate Session"
        size="sm"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setKillTarget(null)}
              disabled={killing}
              className="border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)] disabled:opacity-50"
              style={{ borderRadius: "2px", minHeight: 40 }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void executeKillSession(); }}
              disabled={killing}
              className="bg-[var(--color-status-error)] px-4 py-2 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ borderRadius: "2px", minHeight: 40 }}
            >
              {killing ? "Terminating..." : "Terminate"}
            </button>
          </div>
        }
      >
        <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          Terminate{" "}
          <span
            className="font-medium text-[var(--color-text-primary)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {killTarget?.title}
          </span>
          ? The agent process will be stopped.
        </p>
      </Modal>

      {errorMessage && (
        <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-status-error)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[12px] text-[var(--color-status-error)] shadow-[var(--box-shadow-lg,0_14px_40px_rgba(0,0,0,0.18))]">
          <span className="min-w-0 flex-1">{errorMessage}</span>
          <button
            type="button"
            className="ml-2 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
            onClick={() => setErrorMessage(null)}
            aria-label="Dismiss error"
          >
            &times;
          </button>
        </div>
      )}
    </div>
  );
}

function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setCoords({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
    setVisible(true);
  }, []);

  const hide = useCallback(() => setVisible(false), []);

  return (
    <div ref={triggerRef} onPointerEnter={show} onPointerLeave={hide}>
      {children}
      {visible && coords
        ? createPortal(
            <span
              className="pointer-events-none fixed z-[9999] -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-2 py-1 font-[family-name:var(--font-sans)] text-[11px] font-medium text-[var(--color-text-primary)] shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
              style={{ top: coords.top, left: coords.left }}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </div>
  );
}

function SidebarIconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick?.();
        }}
        aria-label={label}
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-transparent transition-all duration-100 hover:border-[var(--color-border-default)] hover:bg-[var(--color-bg-elevated-hover)] hover:text-[var(--color-text-secondary)]"
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function UnifiedSidebar({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  mobileOpen = false,
  onMobileClose,
  onAddProject,
  collapsed = false,
  onToggleCollapse,
  width = 228,
  onWidthChange,
}: UnifiedSidebarProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (mobileOpen) {
      previousFocusRef.current = document.activeElement;
      closeRef.current?.focus();
    } else if (previousFocusRef.current instanceof HTMLElement) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [mobileOpen]);

  const handleDrawerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onMobileClose?.();
        return;
      }
      if (e.key === "Tab" && drawerRef.current) {
        const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onMobileClose],
  );

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startWidth = width;

      function onPointerMove(event: PointerEvent) {
        if (!isResizing.current) return;
        const newWidth = Math.min(
          SIDEBAR_MAX_WIDTH,
          Math.max(SIDEBAR_MIN_WIDTH, startWidth + (event.clientX - startX)),
        );
        onWidthChange?.(newWidth);
      }

      function onPointerUp() {
        isResizing.current = false;
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    },
    [width, onWidthChange],
  );

  const contentProps = {
    projects,
    sessions,
    activeProjectId,
    activeSessionId,
    onAddProject,
  };

  return (
    <>
      {/* Desktop sidebar */}
      <div className="relative hidden shrink-0 sticky top-0 self-start lg:block" style={{ width: collapsed ? 16 : width }}>
        <aside
          className={cn(
            "h-screen overflow-hidden border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] transition-[width] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] lg:flex lg:flex-col",
            collapsed && "w-0 border-r-0",
          )}
          style={collapsed ? { width: 0 } : { width }}
        >
          <div className="flex h-full flex-col" style={{ minWidth: SIDEBAR_MIN_WIDTH }}>
            <SidebarContent {...contentProps} />
          </div>
        </aside>

        {/* Resize handle */}
        {!collapsed && (
          <div
            className="group/resize absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize"
            onPointerDown={handleResizeStart}
          >
            <div className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-transparent transition-colors duration-100 group-hover/resize:bg-[var(--color-accent)]" />
          </div>
        )}

        {/* Collapse / expand toggle */}
        <button
          type="button"
          className="absolute -right-3 top-3 z-20 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] text-[var(--color-text-tertiary)] shadow-sm transition-colors duration-100 hover:bg-[var(--color-bg-elevated-hover)] hover:text-[var(--color-text-secondary)]"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleCollapse}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </button>
      </div>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div
          ref={drawerRef}
          className="fixed inset-0 z-40 lg:hidden"
          aria-modal="true"
          role="dialog"
          aria-label="Workspace navigation"
          onKeyDown={handleDrawerKeyDown}
        >
          <button
            type="button"
            className="absolute inset-0 bg-[rgba(0,0,0,0.5)] backdrop-blur-[2px]"
            aria-label="Close workspace switcher"
            onClick={onMobileClose}
            tabIndex={-1}
          />
          <div className="absolute inset-y-0 left-0 flex w-[86vw] max-w-[280px] flex-col overflow-hidden border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-[0_18px_60px_rgba(0,0,0,0.28)]">
            <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
              <span className="font-[family-name:var(--font-mono)] text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
                Workspaces
              </span>
              <button
                ref={closeRef}
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated-hover)]"
                onClick={onMobileClose}
                aria-label="Close workspace switcher"
              >
                <CloseIcon />
              </button>
            </div>
            <SidebarContent {...contentProps} />
          </div>
        </div>
      ) : null}
    </>
  );
}

const AGENT_DOT_COLORS: Record<AttentionLevel, string> = {
  working: "var(--color-status-working)",
  respond: "var(--color-status-attention)",
  review: "var(--color-accent-violet)",
  merge: "var(--color-status-ready)",
  pending: "var(--color-text-tertiary)",
  done: "var(--color-text-quaternary, var(--color-text-tertiary))",
};

const ATTENTION_BORDER_CLASS: Record<AttentionLevel, string> = {
  working: "border-l-[var(--color-status-working)]",
  respond: "border-l-[var(--color-status-attention)]",
  review: "border-l-[var(--color-accent-violet)]",
  merge: "border-l-[var(--color-status-ready)]",
  pending: "border-l-[var(--color-border-subtle)]",
  done: "border-l-[var(--color-border-subtle)]",
};

const ATTENTION_STATUS_LABEL: Record<AttentionLevel, string> = {
  working: "working",
  respond: "waiting",
  review: "in review",
  merge: "mergeable",
  pending: "pending",
  done: "done",
};

function AgentActivityDot({ attention }: { attention: AttentionLevel }) {
  const color = AGENT_DOT_COLORS[attention];
  const isAnimated = attention === "working";
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {isAnimated && (
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
          style={{ backgroundColor: color }}
        />
      )}
      <span
        className="relative inline-flex h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}

function StatusChip({ attention }: { attention: AttentionLevel }) {
  const label = ATTENTION_STATUS_LABEL[attention];
  const color = AGENT_DOT_COLORS[attention];
  if (attention === "pending" || attention === "done") return null;
  return (
    <span
      className="shrink-0 rounded-[3px] px-1 py-px text-[9px] font-semibold uppercase tracking-[0.055em]"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {label}
    </span>
  );
}

function PopoverField({
  label,
  valueLabel,
  onToggle,
  isOpen,
  onClose,
  children,
}: {
  label: string;
  valueLabel: string;
  onToggle: () => void;
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent | PointerEvent) {
      if (!fieldRef.current?.contains(event.target as Node)) {
        onClose();
      }
    }

    if (!isOpen) return;
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen, onClose]);

  return (
    <div ref={fieldRef} className="relative grid grid-cols-[60px_minmax(0,1fr)] items-center gap-2">
      <label className="font-[family-name:var(--font-mono)] text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
        {label}
      </label>
      <button
        type="button"
        onClick={onToggle}
        className="flex h-[32px] min-w-0 w-full items-center justify-between rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 text-left text-[12px] font-medium tracking-[-0.011em] text-[var(--color-text-primary)] transition-colors duration-100 hover:border-[var(--color-border-strong)]"
      >
        <span className="min-w-0 flex-1 truncate">{valueLabel}</span>
        <span className="ml-2 shrink-0 text-[var(--color-text-tertiary)]">
          <SelectChevronIcon />
        </span>
      </button>
      {isOpen ? (
        <div className="absolute right-0 top-[36px] z-30 min-w-[200px] rounded-[var(--radius-lg)] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-1.5 shadow-[var(--box-shadow-lg,0_18px_44px_rgba(0,0,0,0.22))]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function PopoverOption({
  label,
  selected,
  onSelect,
  swatch,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  swatch?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-left text-[13px] tracking-[-0.011em] transition-colors duration-100",
        selected
          ? "bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)]"
          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated-hover)] hover:text-[var(--color-text-primary)]",
      )}
    >
      {swatch !== undefined ? (
        <span
          className="h-3 w-3 shrink-0 rounded-[2px]"
          style={{ background: swatch, border: swatch === "transparent" ? "1px solid var(--color-border-default)" : "none" }}
        >
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? <CheckIcon /> : null}
    </button>
  );
}

function SidebarMenuButton({
  icon,
  label,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left text-[13px] tracking-[-0.011em] text-[var(--color-text-primary)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated-hover)]"
    >
      {icon ? <span className="shrink-0 text-[var(--color-text-tertiary)]">{icon}</span> : null}
      {label}
    </button>
  );
}

/* ── Icons ─────────────────────────────────────────────────────────── */

function ClockIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.75V12l2.75 1.75" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function SortIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
      <path d="M5 7h10M5 12h7M5 17h4" />
      <path d="m17 15 2 2 2-2" />
      <path d="M19 7v10" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
      <path d="M3.75 7.5A1.75 1.75 0 0 1 5.5 5.75h4.1l1.75 1.75h7.15A1.75 1.75 0 0 1 20.25 9.25v8A1.75 1.75 0 0 1 18.5 19H5.5a1.75 1.75 0 0 1-1.75-1.75V7.5Z" />
      <path d="M12 10.25v5.5M9.25 13h5.5" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 7h1a5 5 0 0 1 0 10h-1M9 17H8a5 5 0 0 1 0-10h1" />
      <path d="M8.5 12h7" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round">
      <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function SelectChevronIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="m8 10 4-4 4 4M16 14l-4 4-4-4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
      <path d="m5 12 4.5 4.5L19 7" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function FolderOpenIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.75 7.5A1.75 1.75 0 0 1 5.5 5.75h4.1l1.75 1.75h7.15A1.75 1.75 0 0 1 20.25 9.25v.25" />
      <path d="M3.08 12.25a1.25 1.25 0 0 1 1.22-1h15.4a1.25 1.25 0 0 1 1.22 1.53l-1.5 6a1.25 1.25 0 0 1-1.22.97H5.5a1.75 1.75 0 0 1-1.75-1.75l-.67-5.75Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  );
}

function SidebarAgentIcon({ agentId, attention }: { agentId: string | undefined; attention: AttentionLevel }) {
  const label = formatAgentLabel(agentId);
  const { src, fallback } = getAgentIconProps(agentId);
  const badgeColor = AGENT_DOT_COLORS[attention];
  const isAnimated = attention === "working";

  return (
    <span
      className="relative shrink-0"
      aria-label={`${label} agent`}
      title={label}
    >
      {src ? <AgentFaviconIcon src={src} fallback={fallback} /> : <AgentFaviconIconFallback fallback={fallback} />}
      <span className="absolute -bottom-px -right-px flex h-[7px] w-[7px] items-center justify-center rounded-full bg-[var(--color-bg-primary)] p-px">
        {isAnimated && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
            style={{ backgroundColor: badgeColor }}
          />
        )}
        <span
          className="relative inline-flex h-full w-full rounded-full"
          style={{ backgroundColor: badgeColor }}
        />
      </span>
    </span>
  );
}

function AgentFaviconIconFallback({ fallback }: { fallback: string }) {
  return (
    <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-slate-100 text-[9px] font-semibold tracking-[0.08em] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
      {fallback}
    </span>
  );
}

function AgentFaviconIcon({
  src,
  fallback,
}: {
  src: string;
  fallback: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <AgentFaviconIconFallback fallback={fallback} />;
  }

  return (
    <span className="flex h-[18px] w-[18px] items-center justify-center overflow-hidden rounded-[4px] bg-white ring-1 ring-slate-200/70 dark:bg-slate-900 dark:ring-slate-700/70">
      <img
        alt=""
        aria-hidden="true"
        className="h-full w-full object-cover"
        src={src}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
