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

  const governanceLink = (
    <div className={cn(
      "border-t border-[var(--color-border-subtle)] px-3 py-3",
      projects.length <= 1 && "border-t-0",
    )}>
      <a
        href="/governance"
        className={cn(
          "flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12px] transition-colors hover:no-underline",
          pathname === "/governance"
            ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
            : "text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[var(--color-text-primary)]",
        )}
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
        </svg>
        Governance
      </a>
    </div>
  );

  if (projects.length <= 1) {
    return (
      <aside className="flex h-full w-[180px] flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
        <div className="flex-1" />
        {governanceLink}
      </aside>
    );
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
      {governanceLink}
    </aside>
  );
}
