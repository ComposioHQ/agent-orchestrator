"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { isOrchestratorSession } from "@aoagents/ao-core/types";

import { usePopoverClamp } from "@/hooks/usePopoverClamp";
import { projectDashboardPath } from "@/lib/routes";
import { getAttentionLevel, type DashboardSession } from "@/lib/types";
import { AddProjectModal } from "./AddProjectModal";
import { ProjectSidebarFooter } from "./ProjectSidebarFooter";
import { ProjectSettingsModal } from "./ProjectSettingsModal";
import { ProjectSidebarCollapsed } from "./ProjectSidebarCollapsed";
import { ProjectSidebarProjectCard } from "./ProjectSidebarProjectCard";
import {
  getProjectHealth,
  getProjectStatusSummary,
  loadShowSessionId,
  type ProjectSidebarProps,
  SHOW_SESSION_ID_KEY,
} from "./ProjectSidebar.shared";

const SESSION_SORT_PRIORITY = ["respond", "action", "review", "merge", "pending", "working", "done"];

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
  onMobileClose,
}: ProjectSidebarProps) {
  const router = useRouter();
  const isLoading = loading || sessions === null;

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(activeProjectId && activeProjectId !== "all" ? [activeProjectId] : []),
  );
  const [showKilled, setShowKilled] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [showSessionId, setShowSessionId] = useState<boolean>(loadShowSessionId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectMenuOpenId, setProjectMenuOpenId] = useState<string | null>(null);
  const [projectSettingsProjectId, setProjectSettingsProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [removedProjectIds, setRemovedProjectIds] = useState<Set<string>>(new Set());
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsPopoverRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuPopoverRef = useRef<HTMLDivElement>(null);

  usePopoverClamp(settingsOpen, settingsPopoverRef);
  usePopoverClamp(Boolean(projectMenuOpenId), projectMenuPopoverRef);

  useEffect(() => {
    try {
      window.localStorage.setItem(SHOW_SESSION_ID_KEY, String(showSessionId));
    } catch {
      // localStorage unavailable — accept the in-memory state for this session.
    }
  }, [showSessionId]);

  useEffect(() => {
    if (!settingsOpen) return;

    const handlePointer = (event: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setSettingsOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };

    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!projectMenuOpenId) return;

    const handlePointer = (event: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(event.target as Node)) {
        setProjectMenuOpenId(null);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectMenuOpenId(null);
    };

    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [projectMenuOpenId]);

  useEffect(() => {
    if (activeProjectId && activeProjectId !== "all") {
      setExpandedProjects((prev) => new Set([...prev, activeProjectId]));
    }
  }, [activeProjectId]);

  useEffect(() => {
    setRemovedProjectIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(
        [...prev].filter((projectId) => !projects.some((project) => project.id === projectId)),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [projects]);

  const visibleProjects = useMemo(
    () => projects.filter((project) => !removedProjectIds.has(project.id)),
    [projects, removedProjectIds],
  );

  const prefixByProject = useMemo(
    () => new Map(visibleProjects.map((project) => [project.id, project.sessionPrefix ?? project.id])),
    [visibleProjects],
  );

  const allPrefixes = useMemo(
    () => visibleProjects.map((project) => project.sessionPrefix ?? project.id),
    [visibleProjects],
  );

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, DashboardSession[]>();
    const validProjectIds = new Set(visibleProjects.map((project) => project.id));

    for (const session of sessions ?? []) {
      if (!validProjectIds.has(session.projectId)) continue;
      if (isOrchestratorSession(session, prefixByProject.get(session.projectId), allPrefixes)) continue;
      if (session.status === "killed" && !showKilled) continue;
      if (getAttentionLevel(session) === "done" && !showDone) continue;

      const list = map.get(session.projectId) ?? [];
      list.push(session);
      map.set(session.projectId, list);
    }

    for (const list of map.values()) {
      list.sort((left, right) => {
        const levelDelta =
          SESSION_SORT_PRIORITY.indexOf(getAttentionLevel(left)) -
          SESSION_SORT_PRIORITY.indexOf(getAttentionLevel(right));
        if (levelDelta !== 0) return levelDelta;
        return Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
      });
    }

    return map;
  }, [sessions, prefixByProject, allPrefixes, visibleProjects, showKilled, showDone]);

  const navigate = (url: string, session?: DashboardSession) => {
    if (session) {
      try {
        sessionStorage.setItem(`ao-session-nav:${session.id}`, JSON.stringify(session));
      } catch {
        // sessionStorage unavailable — silent fallback
      }
    }
    router.push(url);
    onMobileClose?.();
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

  const handleOpenProjectSettings = (projectId: string) => {
    setProjectMenuOpenId(null);
    setProjectSettingsProjectId(projectId);
  };

  const handleToggleProjectMenu = (projectId: string) => {
    setProjectMenuOpenId((current) => (current === projectId ? null : projectId));
  };

  const handleRemoveProject = async (project: (typeof projects)[number]) => {
    const confirmed = window.confirm(
      `Remove project ${project.name} from AO? This clears its AO sessions/history and removes it from the portfolio, but keeps the repository folder on disk.`,
    );
    if (!confirmed) return;

    setDeletingProjectId(project.id);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          (body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : null) ?? "Failed to remove project.",
        );
      }

      setRemovedProjectIds((prev) => new Set(prev).add(project.id));
      setExpandedProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.id);
        return next;
      });
      setProjectMenuOpenId(null);
      if (activeProjectId === project.id) {
        router.push("/");
      } else if ("refresh" in router && typeof router.refresh === "function") {
        router.refresh();
      }
      onMobileClose?.();
    } catch (caughtError) {
      window.alert(caughtError instanceof Error ? caughtError.message : "Failed to remove project.");
    } finally {
      setDeletingProjectId(null);
    }
  };

  if (collapsed) {
    return (
      <ProjectSidebarCollapsed
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        navigate={navigate}
        sessionsByProject={sessionsByProject}
        visibleProjects={visibleProjects}
      />
    );
  }

  return (
    <aside className="project-sidebar flex h-full flex-col">
      <div className="project-sidebar__compact-hdr">
        <span className="project-sidebar__sect-label">Projects</span>
        <button
          type="button"
          className="project-sidebar__add-btn"
          aria-label="New project"
          onClick={() => setAddProjectOpen(true)}
        >
          <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

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

      <div className="project-sidebar__tree flex-1 overflow-x-hidden overflow-y-auto">
        {visibleProjects.map((project) => {
          const workerSessions = sessionsByProject.get(project.id) ?? [];
          const visibleSessions = workerSessions;
          const projectHref = projectDashboardPath(project.id);
          const statusSummary = isLoading
            ? { tone: "pending" as const, detail: "Loading sessions" }
            : getProjectStatusSummary(visibleSessions);
          const orchestratorSession = sessions?.find(
            (session) =>
              isOrchestratorSession(session, prefixByProject.get(session.projectId), allPrefixes) &&
              session.projectId === project.id,
          );

          return (
            <ProjectSidebarProjectCard
              key={project.id}
              activeSessionId={activeSessionId}
              deletingProjectId={deletingProjectId}
              error={error}
              health={getProjectHealth(visibleSessions)}
              isActive={activeProjectId === project.id}
              isDegraded={Boolean(project.resolveError)}
              isExpanded={expandedProjects.has(project.id)}
              isLoading={isLoading}
              navigate={navigate}
              onMobileClose={onMobileClose}
              onOpenSettings={handleOpenProjectSettings}
              onRemoveProject={handleRemoveProject}
              onRetry={onRetry}
              onToggleExpand={toggleExpand}
              onToggleMenu={handleToggleProjectMenu}
              orchestratorSession={orchestratorSession}
              project={project}
              projectHref={projectHref}
              projectMenuOpen={projectMenuOpenId === project.id}
              projectMenuPopoverRef={projectMenuPopoverRef}
              projectMenuRef={projectMenuRef}
              showSessionId={showSessionId}
              statusSummary={statusSummary}
              visibleSessions={visibleSessions}
              workerSessions={workerSessions}
            />
          );
        })}
      </div>

      <ProjectSidebarFooter
        settingsOpen={settingsOpen}
        settingsPopoverRef={settingsPopoverRef}
        settingsRef={settingsRef}
        setSettingsOpen={setSettingsOpen}
        showDone={showDone}
        showKilled={showKilled}
        showSessionId={showSessionId}
        setShowDone={setShowDone}
        setShowKilled={setShowKilled}
        setShowSessionId={setShowSessionId}
      />
      <AddProjectModal open={addProjectOpen} onClose={() => setAddProjectOpen(false)} />
      <ProjectSettingsModal
        open={projectSettingsProjectId !== null}
        projectId={projectSettingsProjectId}
        onClose={() => setProjectSettingsProjectId(null)}
      />
    </aside>
  );
}
