"use client";

import { useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  activeProjectId: string | undefined;
}

export function ProjectSidebar({ projects, activeProjectId }: ProjectSidebarProps) {
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
    </aside>
  );
}
