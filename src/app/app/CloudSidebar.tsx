"use client";

import type {
  CurrentAccount,
  Project,
  Session,
} from "@aoagents/cloud-client";
import {
  Bot,
  Folder,
  FolderOpen,
  LogOut,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Share2,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { CloudWorkspaceSwitcher } from "./CloudWorkspaceSwitcher";

export function CloudSidebar({
  account,
  onNewProject,
  onOpenCommand,
  onOpenSettings,
  onSelectOrganization,
  onSelectProject,
  onSelectSession,
  onDeleteSession,
  onProjectSettings,
  onShareProject,
  projects,
  selectedOrganizationId,
  selectedProjectId,
  selectedSessionId,
  sessions,
}: {
  account: CurrentAccount;
  onNewProject: () => void;
  onOpenCommand: () => void;
  onOpenSettings: () => void;
  onSelectOrganization: (organizationId: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (session: Session) => void;
  onProjectSettings: (project: Project) => void;
  onShareProject: (project: Project) => void;
  projects: Project[];
  selectedOrganizationId: string;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  sessions: Session[];
}) {
  const [closedProjects, setClosedProjects] = useState<Set<string>>(new Set());
  const [openProjectMenu, setOpenProjectMenu] = useState<string | null>(null);
  const [openSessionMenu, setOpenSessionMenu] = useState<string | null>(null);
  const projectItems = projects.filter((project) => !isStandaloneProject(project));
  const standaloneRows = projects
    .filter(isStandaloneProject)
    .flatMap((project) =>
      sessions
        .filter((session) => session.projectId === project.id)
        .map((session) => ({ project, session })),
    );

  return (
    <aside className="flex min-h-0 flex-col bg-[var(--color-bg-sidebar)]">
      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2 pt-2">
        <img
          src="/ao-logo.svg"
          alt=""
          aria-hidden="true"
          className="size-[22px] shrink-0 -translate-y-[3px] rounded-md object-cover"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-bold leading-tight tracking-[-0.025em]">
          Agent Orchestrator
        </span>
      </div>

      <CloudWorkspaceSwitcher
        account={account}
        onSelect={onSelectOrganization}
        selectedOrganizationId={selectedOrganizationId}
      />

      <div className="px-2 pb-4">
        <button
          type="button"
          aria-label="Search"
          className="flex h-8 w-full items-center gap-2 rounded-lg bg-[var(--color-bg-primary)] px-2.5 text-sm text-[var(--muted-foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
          onClick={onOpenCommand}
        >
          <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">Search</span>
          <kbd className="rounded-sm border border-white/10 px-1.5 py-0.5 font-mono text-[10px]">
            ⌘ K
          </kbd>
        </button>
      </div>

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
              <div
                className={`group relative flex items-center rounded-lg ${
                  selectedProjectId === project.id
                    ? "bg-[var(--color-interactive-active)]"
                    : ""
                }`}
              >
                <button
                  type="button"
                  aria-expanded={open}
                  className={`flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 text-left text-sm font-medium transition-colors hover:bg-[var(--color-interactive-hover)] ${
                    selectedProjectId === project.id
                      ? "text-[var(--foreground)]"
                      : "text-[var(--muted-foreground)]"
                  }`}
                  onClick={() => {
                    onSelectProject(project.id);
                    setClosedProjects((current) => {
                      const next = new Set(current);
                      if (next.has(project.id)) next.delete(project.id);
                      else next.add(project.id);
                      return next;
                    });
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
                </button>
                <button
                  aria-expanded={openProjectMenu === project.id}
                  aria-haspopup="menu"
                  aria-label={`Actions for ${project.displayName}`}
                  className="mr-1 grid size-7 shrink-0 place-items-center rounded-md text-[var(--color-text-passive)] opacity-0 hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() =>
                    setOpenProjectMenu((current) =>
                      current === project.id ? null : project.id,
                    )
                  }
                  type="button"
                >
                  <MoreHorizontal className="size-3.5" aria-hidden="true" />
                </button>
                {openProjectMenu === project.id ? (
                  <div
                    className="absolute left-8 top-8 z-30 w-44 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] p-1 shadow-xl"
                    role="menu"
                  >
                    <button
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
                      onClick={() => {
                        setOpenProjectMenu(null);
                        onProjectSettings(project);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Settings className="size-3.5" aria-hidden="true" />
                      Project settings
                    </button>
                    <button
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
                      onClick={() => {
                        setOpenProjectMenu(null);
                        onShareProject(project);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Share2 className="size-3.5" aria-hidden="true" />
                      Share project
                    </button>
                  </div>
                ) : null}
              </div>
              {open ? (
                <div className="ml-3.5 py-1">
                  {projectSessions.map((session) => (
                    <div
                      className="group relative flex items-center"
                      key={session.id}
                    >
                      <button
                        type="button"
                        className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 pr-8 text-left text-sm transition-colors hover:bg-[var(--color-interactive-hover)] ${
                          selectedSessionId === session.id
                            ? "bg-[var(--color-interactive-active)] text-[var(--foreground)]"
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
                      <SessionActions
                        onDelete={() => {
                          setOpenSessionMenu(null);
                          onDeleteSession(session);
                        }}
                        onToggle={() =>
                          setOpenSessionMenu((current) =>
                            current === session.id ? null : session.id,
                          )
                        }
                        open={openSessionMenu === session.id}
                        session={session}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {standaloneRows.length > 0 ? (
          <div className="mt-4 border-t border-[var(--color-border-strong)] pt-3">
            <div className="mb-1 px-2 font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-passive)]">
              Standalone Agents
            </div>
            <div className="space-y-1">
              {standaloneRows.map(({ project, session }) => (
                <div
                  className="group relative flex items-center"
                  key={session.id}
                  title={project.displayName}
                >
                  <button
                    className={`flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 pr-8 text-left text-sm transition-colors hover:bg-[var(--color-interactive-hover)] ${
                      selectedSessionId === session.id
                        ? "bg-[var(--color-interactive-active)] text-[var(--foreground)]"
                        : "text-[var(--muted-foreground)]"
                    }`}
                    onClick={() => onSelectSession(session.id)}
                    type="button"
                  >
                    <Bot className="size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">
                      {session.displayName}
                    </span>
                    <span
                      className={`size-2 shrink-0 rounded-full ${activityDot(session.activityState)}`}
                      aria-hidden="true"
                    />
                  </button>
                  <SessionActions
                    onDelete={() => {
                      setOpenSessionMenu(null);
                      onDeleteSession(session);
                    }}
                    onToggle={() =>
                      setOpenSessionMenu((current) =>
                        current === session.id ? null : session.id,
                      )
                    }
                    open={openSessionMenu === session.id}
                    session={session}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-auto border-t border-[var(--color-border-strong)] p-2">
        <button
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
          onClick={onOpenSettings}
          type="button"
        >
          <Settings className="size-3.5" aria-hidden="true" />
          Settings
        </button>
        <div className="px-2.5 py-2">
          <div className="truncate text-xs text-[var(--foreground)]">
            {account.user.displayName}
          </div>
          <div className="truncate text-[10px] text-[var(--color-text-passive)]">
            {account.user.email}
          </div>
        </div>
        <a
          className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
          href="/sign-out"
        >
          <LogOut className="size-3.5" aria-hidden="true" />
          Sign out
        </a>
      </div>
    </aside>
  );
}

function SessionActions({
  onDelete,
  onToggle,
  open,
  session,
}: {
  onDelete: () => void;
  onToggle: () => void;
  open: boolean;
  session: Session;
}) {
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Actions for ${session.displayName}`}
        className="absolute right-1 grid size-7 shrink-0 place-items-center rounded-md text-[var(--color-text-passive)] opacity-0 hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] focus-visible:opacity-100 group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        type="button"
      >
        <MoreHorizontal className="size-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="absolute right-1 top-8 z-40 w-40 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] p-1 shadow-xl"
          role="menu"
        >
          <button
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-[var(--color-error)] hover:bg-[var(--color-error)]/10"
            onClick={() => {
              if (
                window.confirm(
                  `Delete ${session.displayName}? Its sandbox will be stopped, while durable audit history is retained.`,
                )
              ) {
                onDelete();
              }
            }}
            role="menuitem"
            type="button"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            Delete session
          </button>
        </div>
      ) : null}
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
