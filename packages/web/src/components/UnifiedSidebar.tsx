"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { getAttentionLevel, type AttentionLevel, type DashboardSession, type PortfolioProjectSummary } from "@/lib/types";
import { getProjectSessionHref } from "@/lib/project-utils";
import { getSessionTitle } from "@/lib/format";
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
  onCloneFromUrl?: () => void;
  onQuickStart?: () => void;
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

function SidebarContent({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  compact: _compact = false,
  onAddProject,
  onCloneFromUrl,
  onQuickStart,
}: {
  projects: PortfolioProjectSummary[];
  sessions?: DashboardSession[];
  activeProjectId?: string;
  activeSessionId?: string;
  compact?: boolean;
  onAddProject?: () => void;
  onCloneFromUrl?: () => void;
  onQuickStart?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const isHome = pathname === "/activity";
  const [groupBy, setGroupBy] = useState<"repo" | "status">("repo");
  const [repoFilter, setRepoFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [openFilter, setOpenFilter] = useState<null | "groupBy" | "repo" | "status">(null);
  const [resourceProject, setResourceProject] = useState<PortfolioProjectSummary | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [spawnMenuProjectId, setSpawnMenuProjectId] = useState<string | null>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const spawnMenuRef = useRef<HTMLDivElement>(null);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  const visibleProjects = useMemo(() => {
    let filtered = sortedProjects;
    if (groupBy === "repo" && repoFilter !== "all") {
      filtered = filtered.filter((project) => project.id === repoFilter);
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
  }, [groupBy, repoFilter, sortedProjects, statusFilter]);

  const activeAgents = useMemo(() => {
    if (!sessions) return [];
    return sessions
      .filter((s) => {
        const level = getAttentionLevel(s);
        return level !== "done";
      })
      .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
  }, [sessions]);

  const projectNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.name);
    return map;
  }, [projects]);

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

  function handleRemoveProject(projectId: string, projectName: string) {
    setRemoveTarget({ id: projectId, name: projectName });
  }

  async function executeRemoveProject() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await fetch(`/api/projects/${encodeURIComponent(removeTarget.id)}`, { method: "DELETE" });
      setRemoveTarget(null);
      router.refresh();
    } catch (error) {
      console.error(error);
    } finally {
      setRemoving(false);
    }
  }

  async function handleSpawnAgent(projectId: string, agent?: string) {
    try {
      const res = await fetch("/api/orchestrators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, ...(agent ? { agent } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; orchestrator?: { id: string } }
        | null;
      if (!res.ok || !body?.orchestrator?.id) {
        throw new Error(body?.error || "Failed to spawn orchestrator");
      }
      router.push(getProjectSessionHref(projectId, body.orchestrator.id));
    } catch (error) {
      console.error(error);
    }
  }

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-surface)] text-[var(--color-text-secondary)]">
      {/* Activity link */}
      <div className="border-b border-[var(--color-border-subtle)] px-4 py-4">
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
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
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
              <SidebarMenuButton
                icon={<LinkIcon />}
                label="Clone from URL"
                onClick={() => {
                  setShowAddMenu(false);
                  onCloneFromUrl?.();
                }}
              />
              <SidebarMenuButton
                icon={<ZapIcon />}
                label="Quick start"
                onClick={() => {
                  setShowAddMenu(false);
                  onQuickStart?.();
                }}
              />
            </div>
          ) : null}
        </div>
        </div>
      </div>

      {/* Workspace list */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-4" aria-label="Workspace navigation">
        <div className="space-y-0.5">
          {visibleProjects.map((project) => {
            const isActive = activeProjectId === project.id;
            const attentionPills = getAttentionPills(project);

            return (
              <div
                key={project.id}
                className={cn(
                  "group/row relative rounded-[var(--radius-sm)] transition-colors duration-100",
                  isActive
                    ? "bg-[var(--color-accent-subtle)]"
                    : "hover:bg-[var(--color-bg-elevated-hover)]",
                )}
              >
                {/* Active accent bar */}
                {isActive ? (
                  <span className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-[var(--color-accent)]" />
                ) : null}

                <Link
                  href={`/projects/${encodeURIComponent(project.id)}`}
                  className={cn(
                    "flex min-h-[44px] items-center gap-3 px-3 py-2 text-[13px] tracking-[-0.011em] hover:no-underline",
                    isActive
                      ? "text-[var(--color-text-primary)]"
                      : "text-[var(--color-text-secondary)]",
                  )}
                >
                  <ProjectAvatar
                    projectId={project.id}
                    name={project.name}
                    degraded={project.degraded}
                  />

                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium tracking-[-0.02em]">
                      {project.name}
                    </span>
                    {/* Attention pills — always visible when there's activity */}
                    {attentionPills.length > 0 ? (
                      <div className="mt-0.5 flex items-center gap-1">
                        {attentionPills.map(({ level, count, color, bgColor }) => (
                          <span
                            key={level}
                            className="inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-px text-[9px] font-medium tabular-nums"
                            style={{ color, backgroundColor: bgColor }}
                          >
                            {count}{level[0]}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {/* Action buttons — visible on hover/focus-within for keyboard accessibility */}
                  <div
                    className={cn(
                      "ml-1 flex shrink-0 items-center gap-0.5 transition-opacity duration-100",
                      isActive
                        ? "opacity-100"
                        : "opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100",
                    )}
                  >
                    <SidebarIconButton
                      label="Open from"
                      onClick={() => setResourceProject(project)}
                    >
                      <LinkIcon />
                    </SidebarIconButton>
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
                          <SidebarMenuButton
                            icon={<AgentOpenCodeIcon />}
                            label="Open Code"
                            onClick={() => {
                              setSpawnMenuProjectId(null);
                              void handleSpawnAgent(project.id, "opencode");
                            }}
                          />
                          <SidebarMenuButton
                            icon={<AgentClaudeCodeIcon />}
                            label="Claude Code"
                            onClick={() => {
                              setSpawnMenuProjectId(null);
                              void handleSpawnAgent(project.id, "claude-code");
                            }}
                          />
                          <SidebarMenuButton
                            icon={<AgentCodexIcon />}
                            label="Codex"
                            onClick={() => {
                              setSpawnMenuProjectId(null);
                              void handleSpawnAgent(project.id, "codex");
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                    <SidebarIconButton
                      label="Remove workspace"
                      onClick={() => handleRemoveProject(project.id, project.name)}
                    >
                      <TrashIcon />
                    </SidebarIconButton>
                  </div>
                </Link>
              </div>
            );
          })}
        </div>
      </nav>

      {/* AO Agents */}
      {activeAgents.length > 0 && (
        <div className="border-t border-[var(--color-border-subtle)]">
          <div className="flex items-center justify-between px-4 pb-2 pt-3">
            <span className="font-[family-name:var(--font-mono)] text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              Agents
              <span className="ml-1.5 text-[var(--color-text-quaternary)]">{activeAgents.length}</span>
            </span>
          </div>
          <div className="max-h-[200px] overflow-y-auto px-2 pb-2 scrollbar-thin">
            <div className="space-y-0.5">
              {activeAgents.map((session) => {
                const isActive = activeSessionId === session.id;
                const attention = getAttentionLevel(session);
                const title = getSessionTitle(session);
                const projectName = projectNameMap.get(session.projectId);

                return (
                  <Link
                    key={session.id}
                    href={getProjectSessionHref(session.projectId, session.id)}
                    className={cn(
                      "group/agent relative flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-[12px] tracking-[-0.011em] transition-colors duration-100 hover:no-underline",
                      isActive
                        ? "bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)]"
                        : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated-hover)]",
                    )}
                  >
                    {isActive && (
                      <span className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-[var(--color-accent)]" />
                    )}
                    <AgentActivityDot attention={attention} />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{title}</span>
                      {projectName && (
                        <span className="block truncate text-[10px] text-[var(--color-text-tertiary)]">
                          {projectName}
                        </span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-[var(--color-border-subtle)] px-3 py-3">
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
    </div>
  );
}

function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
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
  children: React.ReactNode;
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
  onCloneFromUrl,
  onQuickStart,
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

  const contentProps = { projects, sessions, activeProjectId, activeSessionId, onAddProject, onCloneFromUrl, onQuickStart };

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
            <SidebarContent {...contentProps} compact />
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
  children: React.ReactNode;
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
  label,
  icon,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
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

const ATTENTION_PILL_CONFIG: Record<
  AttentionLevel,
  { color: string; bgColor: string; priority: number } | null
> = {
  working: { color: "var(--color-status-working)", bgColor: "var(--color-tint-blue)", priority: 0 },
  respond: { color: "var(--color-status-attention)", bgColor: "var(--color-tint-yellow)", priority: 1 },
  review: { color: "var(--color-accent-violet)", bgColor: "var(--color-tint-violet)", priority: 2 },
  merge: { color: "var(--color-status-ready)", bgColor: "var(--color-tint-green)", priority: 3 },
  pending: { color: "var(--color-text-tertiary)", bgColor: "var(--color-tint-neutral)", priority: 4 },
  done: null,
};

function getAttentionPills(project: PortfolioProjectSummary) {
  const pills: { level: AttentionLevel; count: number; color: string; bgColor: string }[] = [];
  for (const [level, config] of Object.entries(ATTENTION_PILL_CONFIG)) {
    if (!config) continue;
    const count = project.attentionCounts[level as AttentionLevel] ?? 0;
    if (count > 0) {
      pills.push({ level: level as AttentionLevel, count, color: config.color, bgColor: config.bgColor });
    }
  }
  return pills.sort((a, b) => {
    const aPriority = ATTENTION_PILL_CONFIG[a.level]?.priority ?? 99;
    const bPriority = ATTENTION_PILL_CONFIG[b.level]?.priority ?? 99;
    return aPriority - bPriority;
  });
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

function ZapIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 4.094 12.688c-.35.418-.525.627-.523.804a.5.5 0 0 0 .185.397c.138.111.41.111.955.111H12l-1 8 8.906-10.688c.35-.418.525-.627.523-.804a.5.5 0 0 0-.185-.397c-.138-.111-.41-.111-.955-.111H12l1-8Z" />
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

function AgentOpenCodeIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17l6-6-6-6M12 19h8" />
    </svg>
  );
}

function AgentClaudeCodeIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM8 12h.01M12 12h.01M16 12h.01" />
    </svg>
  );
}

function AgentCodexIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7 8-4 4 4 4M17 8l4 4-4 4M14 4l-4 16" />
    </svg>
  );
}
