"use client";

import { useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";
import type { SSEDispatcherState } from "@/lib/types";

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  activeProjectId: string | undefined;
  dispatcherState?: SSEDispatcherState | null;
  onToggleDispatcher?: () => void;
  dispatcherOpen?: boolean;
}

export function ProjectSidebar({
  projects,
  activeProjectId,
  dispatcherState,
  onToggleDispatcher,
  dispatcherOpen,
}: ProjectSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();

  const handleProjectClick = (projectId: string | null) => {
    if (projectId === null) {
      router.push(pathname + "?project=all");
    } else {
      router.push(pathname + `?project=${encodeURIComponent(projectId)}`);
    }
  };

  if (projects.length <= 1) {
    return null;
  }

  const dispatcherStatus = dispatcherState?.status ?? "stopped";
  const dispatcherStatusColor =
    dispatcherStatus === "running"
      ? "var(--color-status-ready)"
      : dispatcherStatus === "paused"
        ? "var(--color-status-attention)"
        : "var(--color-text-muted)";

  return (
    <aside className="flex h-full w-[180px] flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
      <div className="border-b border-[var(--color-border-subtle)] px-3 py-3">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
          Projects
        </h2>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        <button
          onClick={() => handleProjectClick(null)}
          className={cn(
            "w-full px-3 py-2 text-left text-[13px] transition-colors",
            activeProjectId === undefined || activeProjectId === "all"
              ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
              : "text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[var(--color-text-primary)]",
          )}
        >
          All Projects
        </button>
        {projects.map((project) => (
          <button
            key={project.id}
            onClick={() => handleProjectClick(project.id)}
            className={cn(
              "w-full px-3 py-2 text-left text-[13px] transition-colors",
              activeProjectId === project.id
                ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                : "text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[var(--color-text-primary)]",
            )}
          >
            {project.name}
          </button>
        ))}
      </nav>

      {/* Dispatcher toggle */}
      <div className="border-t border-[var(--color-border-subtle)] px-3 py-2.5">
        <button
          onClick={onToggleDispatcher}
          className={cn(
            "flex w-full items-center gap-2 rounded-[6px] px-2 py-2 text-[12px] font-medium transition-colors",
            dispatcherOpen
              ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
              : "text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[var(--color-text-primary)]",
          )}
        >
          <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <span className="flex-1 text-left">Dispatcher</span>
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: dispatcherStatusColor }}
            title={dispatcherStatus}
          />
        </button>
      </div>
    </aside>
  );
}
