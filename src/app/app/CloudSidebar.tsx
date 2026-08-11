"use client";

import type {
  CurrentAccount,
  Project,
  Session,
} from "@aoagents/cloud-client";
import {
  Folder,
  FolderOpen,
  LogOut,
  Plus,
  Search,
} from "lucide-react";
import { useState } from "react";

import { CloudWorkspaceSwitcher } from "./CloudWorkspaceSwitcher";

export function CloudSidebar({
  account,
  onNewProject,
  onOpenCommand,
  onSelectOrganization,
  onSelectProject,
  onSelectSession,
  projects,
  selectedOrganizationId,
  selectedProjectId,
  selectedSessionId,
  sessions,
}: {
  account: CurrentAccount;
  onNewProject: () => void;
  onOpenCommand: () => void;
  onSelectOrganization: (organizationId: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  projects: Project[];
  selectedOrganizationId: string;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  sessions: Session[];
}) {
  const [closedProjects, setClosedProjects] = useState<Set<string>>(new Set());

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
            Add a GitHub repository to create your first project.
          </button>
        ) : null}
        {projects.map((project) => {
          const open = !closedProjects.has(project.id);
          const projectSessions = sessions.filter(
            (session) => session.projectId === project.id,
          );
          return (
            <div className="mb-1" key={project.id}>
              <button
                type="button"
                aria-expanded={open}
                className={`flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-medium transition-colors hover:bg-[var(--color-interactive-hover)] ${
                  selectedProjectId === project.id
                    ? "bg-[var(--color-interactive-active)] text-[var(--foreground)]"
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
              {open ? (
                <div className="ml-3.5 py-1">
                  {projectSessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className={`flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-[var(--color-interactive-hover)] ${
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
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-auto border-t border-[var(--color-border-strong)] p-2">
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

function activityDot(activity: Session["activityState"]): string {
  if (activity === "active") return "bg-status-working";
  if (activity === "waiting_input" || activity === "blocked") {
    return "bg-status-needs-you";
  }
  if (activity === "exited") return "bg-status-exited";
  return "bg-status-idle";
}
