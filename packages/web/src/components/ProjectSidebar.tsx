"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";
import type { DashboardOrchestratorLink } from "@/lib/types";

const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 320;

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  activeProjectId: string | undefined;
  orchestrators?: DashboardOrchestratorLink[];
  onSpawnOrchestrator?: (project: ProjectInfo) => Promise<void>;
  spawningProjectIds?: string[];
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  width: number;
  onWidthChange: (width: number) => void;
}

export function ProjectSidebar({
  projects,
  activeProjectId,
  orchestrators = [],
  onSpawnOrchestrator,
  spawningProjectIds = [],
  collapsed,
  onCollapsedChange,
  width,
  onWidthChange,
}: ProjectSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [showAddHint, setShowAddHint] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const handleProjectClick = (projectId: string) => {
    router.push(pathname + `?project=${encodeURIComponent(projectId)}`);
  };

  const handleAllProjects = () => {
    router.push("/");
  };

  const getOrchestrator = (projectId: string) =>
    orchestrators.find((o) => o.projectId === projectId) ?? null;

  const clampWidth = useCallback((w: number) => {
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w));
  }, []);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      dragStartX.current = e.clientX;
      dragStartWidth.current = width;
    },
    [width],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - dragStartX.current;
      onWidthChange(clampWidth(dragStartWidth.current + delta));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, clampWidth, onWidthChange]);

  // Collapsed state: render nothing — the expand button lives in the Dashboard header
  if (collapsed) {
    return null;
  }

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]"
      style={{ width: `${width}px` }}
    >
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-3">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
          Projects
        </h2>
        <button
          onClick={() => onCollapsedChange(true)}
          aria-label="Collapse sidebar"
          className="flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border-subtle)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-[var(--color-text-primary)]"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>
      <div className="px-2 pt-2">
        <button
          onClick={handleAllProjects}
          className={cn(
            "w-full rounded px-2 py-2.5 text-left text-[12px] font-medium transition-colors md:py-1.5",
            activeProjectId === undefined
              ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
              : "text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[var(--color-text-primary)]",
          )}
        >
          All Projects
        </button>
        <button
          onClick={() => setShowAddHint((prev) => !prev)}
          className="w-full rounded px-2 py-2.5 text-left text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[rgba(255,255,255,0.03)] hover:text-[var(--color-text-primary)] md:py-1.5"
        >
          + Add Project
        </button>
        {showAddHint && (
          <p className="px-2 pb-1 text-[10px] leading-snug text-[var(--color-text-tertiary)]">
            Run{" "}
            <code className="rounded bg-[rgba(255,255,255,0.06)] px-1 py-0.5 font-[var(--font-mono)] text-[10px]">
              ao init &lt;path&gt;
            </code>{" "}
            to add a project
          </p>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {projects.length === 0 && (
          <div className="px-3 py-4 text-center">
            <p className="text-[11px] text-[var(--color-text-tertiary)]">
              No projects yet
            </p>
            <p className="mt-2 text-[10px] leading-snug text-[var(--color-text-tertiary)]">
              Run{" "}
              <code className="rounded bg-[rgba(255,255,255,0.06)] px-1 py-0.5 font-[var(--font-mono)] text-[10px]">
                ao init &lt;path&gt;
              </code>{" "}
              to add a project
            </p>
          </div>
        )}
        {projects.map((project) => {
          const orch = getOrchestrator(project.id);
          const isSpawning = spawningProjectIds.includes(project.id);
          return (
            <div key={project.id} className="group flex items-center px-1">
              <button
                onClick={() => handleProjectClick(project.id)}
                className={cn(
                  "min-h-[44px] min-w-0 flex-1 truncate px-2 py-2 text-left text-[13px] transition-colors md:min-h-0",
                  activeProjectId === project.id
                    ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                    : "text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[var(--color-text-primary)]",
                )}
              >
                {project.name}
              </button>
              {orch ? (
                <a
                  href={`/sessions/${encodeURIComponent(orch.id)}`}
                  title="Orchestrator running"
                  className="shrink-0 px-1"
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
                </a>
              ) : onSpawnOrchestrator ? (
                <button
                  type="button"
                  aria-label={`Spawn orchestrator for ${project.name}`}
                  onClick={() => void onSpawnOrchestrator(project)}
                  disabled={isSpawning}
                  className="shrink-0 px-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:text-[var(--color-text-primary)] group-hover:opacity-100 disabled:cursor-wait disabled:opacity-50"
                >
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              ) : null}
            </div>
          );
        })}
      </nav>

      {/* Drag handle */}
      <div
        onMouseDown={handleDragStart}
        data-testid="sidebar-drag-handle"
        className={cn(
          "absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-[var(--color-accent)]",
          isDragging && "bg-[var(--color-accent)]",
        )}
      />
    </aside>
  );
}
