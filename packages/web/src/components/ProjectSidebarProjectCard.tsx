"use client";

import Link from "next/link";
import type { RefObject } from "react";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";
import { projectSessionPath } from "@/lib/routes";
import type { DashboardSession } from "@/lib/types";

import {
  LEVEL_LABELS,
  type ProjectHealth,
  type ProjectStatusSummary,
} from "./ProjectSidebar.shared";
import { ProjectSidebarSessionRow } from "./ProjectSidebarSessionRow";

interface ProjectSidebarProjectCardProps {
  activeSessionId: string | undefined;
  deletingProjectId: string | null;
  error: boolean;
  health: ProjectHealth;
  isActive: boolean;
  isDegraded: boolean;
  isExpanded: boolean;
  isLoading: boolean;
  navigate: (url: string, session?: DashboardSession) => void;
  onMobileClose?: () => void;
  onOpenSettings: (projectId: string) => void;
  onRemoveProject: (project: ProjectInfo) => Promise<void>;
  onRetry?: () => void;
  onToggleExpand: (projectId: string) => void;
  onToggleMenu: (projectId: string) => void;
  orchestratorSession?: DashboardSession;
  project: ProjectInfo;
  projectHref: string;
  projectMenuOpen: boolean;
  projectMenuPopoverRef?: RefObject<HTMLDivElement | null>;
  projectMenuRef?: RefObject<HTMLDivElement | null>;
  showSessionId: boolean;
  statusSummary: ProjectStatusSummary;
  visibleSessions: DashboardSession[];
  workerSessions: DashboardSession[];
}

export function ProjectSidebarProjectCard({
  activeSessionId,
  deletingProjectId,
  error,
  health,
  isActive,
  isDegraded,
  isExpanded,
  isLoading,
  navigate,
  onMobileClose,
  onOpenSettings,
  onRemoveProject,
  onRetry,
  onToggleExpand,
  onToggleMenu,
  orchestratorSession,
  project,
  projectHref,
  projectMenuOpen,
  projectMenuPopoverRef,
  projectMenuRef,
  showSessionId,
  statusSummary,
  visibleSessions,
  workerSessions,
}: ProjectSidebarProjectCardProps) {
  const hasActiveSessions = visibleSessions.length > 0;

  return (
    <div className="project-sidebar__project" data-health={health}>
      <div className="project-sidebar__proj-row flex items-center">
        {isDegraded ? (
          <a
            href={projectHref}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
              event.preventDefault();
              navigate(projectHref);
            }}
            className={cn(
              "project-sidebar__proj-toggle project-sidebar__proj-toggle--link project-sidebar__proj-toggle--degraded",
              isActive && "project-sidebar__proj-toggle--active",
            )}
            aria-current={isActive ? "page" : undefined}
          >
            <span className="sidebar-health-dot project-sidebar__proj-health" data-health="amber" aria-hidden="true" />
            <svg
              className="project-sidebar__proj-chevron project-sidebar__proj-chevron--degraded"
              width="10"
              height="10"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.72 3h16.92a2 2 0 0 0 1.72-3L13.7 3.86a2 2 0 0 0-3.4 0Z" />
            </svg>
            <span className="project-sidebar__proj-name">{project.name}</span>
            <span className="project-sidebar__proj-badge project-sidebar__proj-badge--degraded">degraded</span>
          </a>
        ) : (
          <button
            type="button"
            onClick={() => onToggleExpand(project.id)}
            className={cn(
              "project-sidebar__proj-toggle",
              isActive && "project-sidebar__proj-toggle--active",
            )}
            aria-expanded={isExpanded}
            aria-current={isActive ? "page" : undefined}
          >
            <span className="sidebar-health-dot project-sidebar__proj-health" data-health={health} aria-hidden="true" />
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
        )}

        {!isDegraded ? (
          <Link
            href={projectHref}
            onClick={(event) => {
              event.stopPropagation();
              onMobileClose?.();
            }}
            className="project-sidebar__proj-action"
            aria-label={`Open ${project.name} dashboard`}
            title="Dashboard"
          >
            <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-10h8V3h-8z" />
            </svg>
          </Link>
        ) : null}

        {!isDegraded && orchestratorSession ? (
          <Link
            href={projectSessionPath(project.id, orchestratorSession.id)}
            onClick={(event) => {
              event.stopPropagation();
              onMobileClose?.();
            }}
            className="project-sidebar__proj-action"
            aria-label={`Open ${project.name} orchestrator`}
            title="Orchestrator"
          >
            <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="5" r="2" fill="currentColor" stroke="none" />
              <path d="M12 7v4M12 11H6M12 11h6M6 11v3M12 11v3M18 11v3" />
              <circle cx="6" cy="17" r="2" />
              <circle cx="12" cy="17" r="2" />
              <circle cx="18" cy="17" r="2" />
            </svg>
          </Link>
        ) : null}

        <div
          className="project-sidebar__proj-menu"
          ref={projectMenuOpen ? projectMenuRef : undefined}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleMenu(project.id);
            }}
            className="project-sidebar__proj-action project-sidebar__proj-action--menu"
            aria-label={`Project actions for ${project.name}`}
            aria-expanded={projectMenuOpen}
            aria-haspopup="menu"
            title="Project actions"
          >
            <svg width="12" height="12" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="5" r="1.75" />
              <circle cx="12" cy="12" r="1.75" />
              <circle cx="12" cy="19" r="1.75" />
            </svg>
          </button>
          {projectMenuOpen ? (
            <div
              ref={projectMenuPopoverRef}
              className="project-sidebar__proj-menu-popover"
              role="menu"
              aria-label={`${project.name} actions`}
            >
              <button
                type="button"
                className="project-sidebar__proj-menu-item"
                role="menuitem"
                onClick={() => onOpenSettings(project.id)}
              >
                Project settings
              </button>
              <button
                type="button"
                className="project-sidebar__proj-menu-item project-sidebar__proj-menu-item--danger"
                role="menuitem"
                onClick={() => void onRemoveProject(project)}
                disabled={deletingProjectId === project.id}
              >
                {deletingProjectId === project.id ? "Removing..." : "Remove project"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {isDegraded ? (
        <div className="project-sidebar__degraded-note">Config needs repair</div>
      ) : (
        <div className="project-sidebar__proj-summary" aria-hidden="true">
          <span
            className={cn(
              "project-sidebar__proj-summary-pill",
              `project-sidebar__proj-summary-pill--${statusSummary.tone}`,
            )}
          >
            {LEVEL_LABELS[statusSummary.tone] ?? "done"}
          </span>
          <span className="project-sidebar__proj-summary-text">{statusSummary.detail}</span>
        </div>
      )}

      {!isDegraded && isExpanded ? (
        <div className="project-sidebar__sessions">
          {isLoading ? (
            <div className="space-y-2 px-3 py-2" aria-label="Loading sessions">
              {Array.from({ length: 3 }, (_, index) => (
                <div
                  key={`${project.id}-loading-${index}`}
                  className="flex items-center gap-3 border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-2 py-2"
                >
                  <div className="h-2 w-2 shrink-0 animate-pulse bg-[var(--color-border-strong)]" />
                  <div className="h-3 flex-1 animate-pulse bg-[var(--color-bg-primary)]" />
                  <div className="h-3 w-12 animate-pulse bg-[var(--color-bg-primary)]" />
                </div>
              ))}
            </div>
          ) : visibleSessions.length > 0 ? (
            visibleSessions.map((session) => (
              <ProjectSidebarSessionRow
                key={session.id}
                activeSessionId={activeSessionId}
                navigate={navigate}
                projectId={project.id}
                session={session}
                showSessionId={showSessionId}
              />
            ))
          ) : error ? (
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
          ) : (
            <div className="project-sidebar__empty">No active sessions</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
