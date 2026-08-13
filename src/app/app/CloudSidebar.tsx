"use client";

import type {
  CurrentAccount,
  Project,
  Session,
} from "@aoagents/cloud-client";
import {
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Share2,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { OrchestratorIcon } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import { CloudWorkspaceSwitcher } from "./CloudWorkspaceSwitcher";

export function CloudSidebar({
  account,
  onCreateWorkspace,
  onNewProject,
  onNewSession,
  onOpenCommand,
  onOpenSettings,
  onSelectOrganization,
  onSelectProject,
  onSelectSession,
  onDeleteProject,
  onDeleteSession,
  onProjectSettings,
  onShareProject,
  projects,
  selectedOrganizationId,
  selectedProjectId,
  selectedSessionId,
  sessions,
  mobileOpen = false,
  onCloseMobile,
  parity = false,
}: {
  account: CurrentAccount;
  onCreateWorkspace: () => void;
  onNewProject: () => void;
  onNewSession: (projectId: string) => void;
  onOpenCommand: () => void;
  onOpenSettings: () => void;
  onSelectOrganization: (organizationId: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteProject: (project: Project) => void;
  onDeleteSession: (session: Session) => void;
  onProjectSettings: (project: Project) => void;
  onShareProject: (project: Project) => void;
  projects: Project[];
  selectedOrganizationId: string;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  sessions: Session[];
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
  parity?: boolean;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [closedProjects, setClosedProjects] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("ao.pinned-sessions");
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch { return new Set(); }
  });
  const togglePin = (sessionId: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      try { localStorage.setItem("ao.pinned-sessions", JSON.stringify([...next])); } catch {}
      return next;
    });
  };
  const pinnedSessions = sessions.filter((s) => pinnedIds.has(s.id));
  const projectItems = projects.filter((project) => !isStandaloneProject(project));
  const standaloneRows = projects
    .filter(isStandaloneProject)
    .flatMap((project) =>
      sessions
        .filter((session) => session.projectId === project.id)
        .map((session) => ({ project, session })),
    );

  return (
    <aside className={`${parity ? (mobileOpen ? "flex" : "hidden") : "flex"} min-h-0 flex-col bg-[var(--color-bg-sidebar)] [&_button]:cursor-pointer ${parity ? "fixed inset-y-0 left-0 z-40 w-[min(86vw,280px)] border-r border-[var(--color-border-strong)] shadow-2xl lg:static lg:flex lg:w-auto lg:border-0 lg:shadow-none" : ""}`}>
      {parity && onCloseMobile ? <div className="flex shrink-0 items-center justify-end px-3 pt-2"><button type="button" aria-label="Close navigation" className="grid size-7 place-items-center rounded-md text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] lg:hidden" onClick={onCloseMobile}>×</button></div> : null}

      <CloudWorkspaceSwitcher
        account={account}
        onCreateWorkspace={onCreateWorkspace}
        onOpenSettings={onOpenSettings}
        onSelect={onSelectOrganization}
        selectedOrganizationId={selectedOrganizationId}
      />

      <div className="px-2 pb-4">
        <button
          type="button"
          aria-label="Search"
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] px-2.5 text-sm font-normal text-[var(--muted-foreground)] transition-[background-color,color] duration-150 ease-out hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] hover:text-[var(--foreground)]"
          onClick={onOpenCommand}
        >
          <Search className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left leading-none">Search</span>
          <kbd className="ml-auto shrink-0 rounded-sm border border-[var(--color-border-strong)]/60 bg-[var(--color-bg-secondary)]/50 px-1.5 py-0.5 font-mono text-[10px] leading-none text-[var(--muted-foreground)]/80">
            ⌘ K
          </kbd>
        </button>
      </div>

      {pinnedSessions.length > 0 ? (
        <>
          <div className="flex h-8 shrink-0 items-center gap-2 px-4 text-sm font-medium text-[var(--color-text-passive)]">
            <span className="min-w-0 flex-1 truncate">Pinned</span>
          </div>
          <div className="px-2 pb-2">
            {pinnedSessions.map((session) => (
              <div
                className={`group/session flex h-8 w-full items-center rounded-lg transition-colors hover:bg-[var(--color-interactive-hover)] ${
                  selectedSessionId === session.id
                    ? "bg-[var(--color-interactive-active)]"
                    : ""
                }`}
                key={session.id}
              >
                <div className="flex min-w-0 flex-1 transition-transform duration-100 ease-out active:scale-[0.97]">
                  <button
                    type="button"
                    className={`flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2.5 text-left text-sm outline-none ${
                      selectedSessionId === session.id
                        ? "text-[var(--foreground)]"
                        : "text-[var(--muted-foreground)]"
                    }`}
                    onClick={() => onSelectSession(session.id)}
                  >
                    <span
                      className={`size-2 shrink-0 rounded-full ${activityDot(session.activityState)}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {session.displayName}
                    </span>
                  </button>
                </div>
                <button
                  aria-label="Unpin session"
                  className="grid h-5 w-0 shrink-0 place-items-center overflow-hidden rounded-md text-[var(--color-text-passive)] opacity-0 transition-[width,margin,opacity,color] group-hover/session:mr-1.5 group-hover/session:w-5 group-hover/session:opacity-100 hover:text-[var(--foreground)] [&_svg]:size-3"
                  onClick={(e) => { e.stopPropagation(); togglePin(session.id); }}
                  type="button"
                >
                  <PinOff aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="flex h-8 shrink-0 items-center gap-2 px-4 text-sm font-medium text-[var(--color-text-passive)]">
        <span className="min-w-0 flex-1 truncate">Projects</span>
        <button
          type="button"
          aria-label="New project"
          className="grid size-6 place-items-center rounded-sm hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
          onClick={onNewProject}
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {projects.length === 0 ? (
          <button
            className="mt-2 w-full rounded-lg border border-dashed border-white/10 px-3 py-4 text-left text-xs leading-5 text-[var(--color-text-passive)] hover:border-white/20 hover:text-[var(--muted-foreground)]"
            onClick={onNewProject}
            type="button"
          >
            Create a project or standalone agent to get started.
          </button>
        ) : null}
        {projectItems.map((project) => {
          const open = !closedProjects.has(project.id);
          const projectSessions = sessions.filter(
            (session) => session.projectId === project.id,
          );
          return (
            <div className="mb-1" key={project.id}>
              <ContextMenu>
              <ContextMenuTrigger asChild>
              <div
                className={`group relative flex items-center rounded-lg transition-colors hover:bg-[var(--color-interactive-hover)] ${
                  selectedProjectId === project.id && !selectedSessionId
                    ? "bg-[var(--color-interactive-active)]"
                    : ""
                }`}
              >
                <motion.button
                  type="button"
                  aria-expanded={open}
                  whileTap={prefersReducedMotion ? undefined : { scale: 0.985 }}
                  transition={{ duration: 0.06, ease: "easeOut" }}
                  className={`flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 pr-8 text-left text-sm font-medium ${
                    selectedProjectId === project.id && !selectedSessionId
                      ? "text-[var(--foreground)]"
                      : "text-[var(--muted-foreground)]"
                  }`}
                  onClick={() => {
                    const dashboardActive = selectedProjectId === project.id && !selectedSessionId;
                    if (!open) {
                      setClosedProjects((c) => { const n = new Set(c); n.delete(project.id); return n; });
                      onSelectProject(project.id);
                    } else if (dashboardActive) {
                      setClosedProjects((c) => { const n = new Set(c); n.add(project.id); return n; });
                    } else {
                      onSelectProject(project.id);
                    }
                  }}
                >
                  <span className="relative grid size-4 shrink-0 place-items-center">
                    {open ? (
                      <FolderOpen className="size-4" aria-hidden="true" />
                    ) : (
                      <Folder className="size-4" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {project.displayName}
                  </span>
                </motion.button>
                <button
                  aria-label="Orchestrator"
                  className="grid h-5 w-0 shrink-0 place-items-center overflow-hidden rounded-md text-[var(--color-text-passive)] opacity-0 transition-[width,opacity,color] group-hover:w-5 group-hover:opacity-100 hover:text-[var(--foreground)] [&_svg]:size-3"
                  onClick={(e) => { e.stopPropagation(); onNewSession(project.id); }}
                  type="button"
                >
                  <OrchestratorIcon aria-hidden="true" />
                </button>
                <DropdownMenuPrimitive.Root>
                  <DropdownMenuPrimitive.Trigger asChild>
                    <button
                      aria-label={`Actions for ${project.displayName}`}
                      className="grid h-5 w-0 shrink-0 place-items-center overflow-hidden rounded-md text-[var(--color-text-passive)] opacity-0 transition-[width,margin,opacity,color] group-hover:mr-1.5 group-hover:w-5 group-hover:opacity-100 hover:text-[var(--foreground)] focus-visible:w-5 focus-visible:opacity-100 data-[state=open]:mr-1.5 data-[state=open]:w-5 data-[state=open]:opacity-100 [&_svg]:size-3"
                      type="button"
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </button>
                  </DropdownMenuPrimitive.Trigger>
                  <DropdownMenuPrimitive.Portal>
                    <DropdownMenuPrimitive.Content
                      side="right"
                      align="start"
                      sideOffset={6}
                      className="z-[100] min-w-44 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--popover)] p-1 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
                    >
                      <ProjectMenuItems
                        onDelete={() => { if (window.confirm(`Remove ${project.displayName}?`)) onDeleteProject(project); }}
                        onNewSession={() => onNewSession(project.id)}
                        onSettings={() => onProjectSettings(project)}
                        onShare={() => onShareProject(project)}
                      />
                    </DropdownMenuPrimitive.Content>
                  </DropdownMenuPrimitive.Portal>
                </DropdownMenuPrimitive.Root>
              </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="min-w-44">
                <ContextMenuItem onSelect={() => onNewSession(project.id)}>
                  <Plus aria-hidden="true" />
                  New session
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onProjectSettings(project)}>
                  <Settings aria-hidden="true" />
                  Project settings
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => onShareProject(project)}>
                  <Share2 aria-hidden="true" />
                  Share project
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="text-[var(--destructive)] focus:text-[var(--destructive)] [&_svg]:text-[var(--destructive)]"
                  onSelect={() => { if (window.confirm(`Remove ${project.displayName}?`)) onDeleteProject(project); }}
                >
                  <Trash2 aria-hidden="true" />
                  Remove project
                </ContextMenuItem>
              </ContextMenuContent>
              </ContextMenu>
              <AnimatePresence initial={false}>
                {open && projectSessions.length > 0 && (
                  <motion.div
                    key="sessions"
                    initial={{ height: 0 }}
                    animate={{ height: "auto" }}
                    exit={{ height: 0 }}
                    transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.14, ease: [0.25, 0.46, 0.45, 0.94] }}
                    style={{ overflow: "hidden" }}
                  >
                    <motion.div
                      initial={{ y: -12, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      exit={{ y: -12, opacity: 0 }}
                      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.14, ease: [0.25, 0.46, 0.45, 0.94] }}
                    >
                      <div className="ml-3.5 flex flex-col gap-px py-1">
                        {projectSessions.map((session) => (
                          <ContextMenu key={session.id}>
                          <ContextMenuTrigger asChild>
                          <div
                            className={`group/session flex h-8 w-full items-center rounded-lg transition-colors hover:bg-[var(--color-interactive-hover)] ${
                              selectedSessionId === session.id
                                ? "bg-[var(--color-interactive-active)]"
                                : ""
                            }`}
                          >
                            <div className="flex min-w-0 flex-1 transition-transform duration-100 ease-out active:scale-[0.97]">
                              <button
                                type="button"
                                className={`flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2.5 text-left text-sm outline-none ${
                                  selectedSessionId === session.id
                                    ? "text-[var(--foreground)]"
                                    : "text-[var(--muted-foreground)]"
                                }`}
                                onClick={() => onSelectSession(session.id)}
                              >
                                <span
                                  className={`size-2 shrink-0 rounded-full ${activityDot(session.activityState)}`}
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate">
                                  {session.displayName}
                                </span>
                              </button>
                            </div>
                            <button
                              aria-label={pinnedIds.has(session.id) ? "Unpin session" : "Pin session"}
                              className={`grid h-5 w-0 shrink-0 place-items-center overflow-hidden rounded-md text-[var(--color-text-passive)] opacity-0 transition-[width,opacity,color] group-hover/session:w-5 group-hover/session:opacity-100 hover:text-[var(--foreground)] [&_svg]:size-3 ${pinnedIds.has(session.id) ? "text-[var(--foreground)]" : ""}`}
                              onClick={(e) => { e.stopPropagation(); togglePin(session.id); }}
                              type="button"
                            >
                              {pinnedIds.has(session.id) ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                            </button>
                            <button
                              aria-label="Delete session"
                              className="grid h-5 w-0 shrink-0 place-items-center overflow-hidden rounded-md text-[var(--color-text-passive)] opacity-0 transition-[width,margin,opacity,color] group-hover/session:mr-1.5 group-hover/session:w-5 group-hover/session:opacity-100 hover:text-[var(--destructive)] [&_svg]:size-3"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (window.confirm(`Delete ${session.displayName}?`)) {
                                  onDeleteSession(session);
                                }
                              }}
                              type="button"
                            >
                              <Trash2 aria-hidden="true" />
                            </button>
                          </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent className="min-w-40">
                            <ContextMenuItem onSelect={() => onSelectSession(session.id)}>
                              Open session
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => togglePin(session.id)}>
                              <Pin aria-hidden="true" />
                              {pinnedIds.has(session.id) ? "Unpin" : "Pin"}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              className="text-[var(--destructive)] focus:text-[var(--destructive)] [&_svg]:text-[var(--destructive)]"
                              onSelect={() => { if (window.confirm(`Delete ${session.displayName}?`)) onDeleteSession(session); }}
                            >
                              <Trash2 aria-hidden="true" />
                              Delete session
                            </ContextMenuItem>
                          </ContextMenuContent>
                          </ContextMenu>
                        ))}
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
        {standaloneRows.length > 0 ? (
          <div className="mt-2 pt-2">
            <div className="flex h-8 shrink-0 items-center gap-2 px-2 text-sm font-medium text-[var(--color-text-passive)]">
              <span className="min-w-0 flex-1 truncate">Agents</span>
            </div>
            <div className="flex flex-col gap-px">
              {standaloneRows.map(({ project, session }) => (
                <ContextMenu key={session.id}>
                <ContextMenuTrigger asChild>
                <motion.div
                  whileTap={prefersReducedMotion ? undefined : { scale: 0.985 }}
                  transition={{ duration: 0.06, ease: "easeOut" }}
                  className={`group relative flex items-center rounded-lg transition-colors hover:bg-[var(--color-interactive-hover)] ${
                    selectedSessionId === session.id
                      ? "bg-[var(--color-interactive-active)]"
                      : ""
                  }`}
                  title={project.displayName}
                >
                  <div className="flex min-w-0 flex-1 transition-transform duration-100 ease-out active:scale-[0.97]">
                    <button
                      className={`flex h-9 w-full min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-left text-sm outline-none ${
                        selectedSessionId === session.id
                          ? "text-[var(--foreground)]"
                          : "text-[var(--muted-foreground)]"
                      }`}
                      onClick={() => onSelectSession(session.id)}
                      type="button"
                    >
                      <span
                        className={`size-2 shrink-0 rounded-full ${activityDot(session.activityState)}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {session.displayName}
                      </span>
                    </button>
                  </div>
                  <button
                    aria-label={pinnedIds.has(session.id) ? "Unpin session" : "Pin session"}
                    className={`grid h-5 w-0 shrink-0 place-items-center overflow-hidden rounded-md text-[var(--color-text-passive)] opacity-0 transition-[width,opacity,color] group-hover:w-5 group-hover:opacity-100 hover:text-[var(--foreground)] [&_svg]:size-3 ${pinnedIds.has(session.id) ? "text-[var(--foreground)]" : ""}`}
                    onClick={(e) => { e.stopPropagation(); togglePin(session.id); }}
                    type="button"
                  >
                    {pinnedIds.has(session.id) ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                  </button>
                  <button
                    aria-label="Delete session"
                    className="grid h-5 w-0 shrink-0 place-items-center overflow-hidden rounded-md text-[var(--color-text-passive)] opacity-0 transition-[width,margin,opacity,color] group-hover:mr-1.5 group-hover:w-5 group-hover:opacity-100 hover:text-[var(--destructive)] [&_svg]:size-3"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`Delete ${session.displayName}?`)) {
                        onDeleteSession(session);
                      }
                    }}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </motion.div>
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-40">
                  <ContextMenuItem onSelect={() => onSelectSession(session.id)}>
                    Open session
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => togglePin(session.id)}>
                    <Pin aria-hidden="true" />
                    {pinnedIds.has(session.id) ? "Unpin" : "Pin"}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="text-[var(--destructive)] focus:text-[var(--destructive)] [&_svg]:text-[var(--destructive)]"
                    onSelect={() => { if (window.confirm(`Delete ${session.displayName}?`)) onDeleteSession(session); }}
                  >
                    <Trash2 aria-hidden="true" />
                    Delete session
                  </ContextMenuItem>
                </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-auto border-t border-[var(--color-border-strong)] p-2">
        <button
          className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-sm text-[var(--muted-foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
          onClick={onOpenSettings}
          type="button"
        >
          <Settings className="size-3.5" aria-hidden="true" />
          Settings
        </button>
      </div>
    </aside>
  );
}

function ProjectMenuItems({
  onDelete,
  onNewSession,
  onSettings,
  onShare,
}: {
  onDelete: () => void;
  onNewSession: () => void;
  onSettings: () => void;
  onShare: () => void;
}) {
  const itemClass =
    "relative flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none transition-colors text-[var(--muted-foreground)] focus:bg-[var(--color-interactive-hover)] focus:text-[var(--foreground)] [&_svg]:size-4 [&_svg]:shrink-0";
  return (
    <>
      <DropdownMenuPrimitive.Item className={itemClass} onSelect={onNewSession}>
        <Plus aria-hidden="true" />
        New session
      </DropdownMenuPrimitive.Item>
      <DropdownMenuPrimitive.Item className={itemClass} onSelect={onSettings}>
        <Settings aria-hidden="true" />
        Project settings
      </DropdownMenuPrimitive.Item>
      <DropdownMenuPrimitive.Item className={itemClass} onSelect={onShare}>
        <Share2 aria-hidden="true" />
        Share project
      </DropdownMenuPrimitive.Item>
      <DropdownMenuPrimitive.Item
        className={`${itemClass} text-[var(--destructive)] focus:text-[var(--destructive)] [&_svg]:text-[var(--destructive)]`}
        onSelect={onDelete}
      >
        <Trash2 aria-hidden="true" />
        Remove project
      </DropdownMenuPrimitive.Item>
    </>
  );
}


export function isStandaloneProject(project: Project): boolean {
  return (
    project.config?.standalone === true ||
    project.config?.source === "standalone-agent" ||
    project.repositoryUrl.startsWith("ao-standalone://")
  );
}

function activityDot(activity: Session["activityState"]): string {
  if (activity === "active") return "bg-status-working";
  if (activity === "waiting_input" || activity === "blocked") {
    return "bg-status-needs-you";
  }
  if (activity === "exited") return "bg-status-exited";
  return "bg-status-idle";
}
