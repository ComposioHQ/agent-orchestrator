"use client";

import { cn } from "@/lib/cn";
import type { PortfolioProjectSummary } from "@/lib/types";

interface ProjectRailProps {
  projects: PortfolioProjectSummary[];
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

type ProjectHealth = "red" | "yellow" | "green" | "gray";

function getProjectHealth(project: PortfolioProjectSummary): ProjectHealth {
  if (project.degraded) return "red";
  if (project.attentionCounts.respond > 0) return "red";
  if (project.attentionCounts.review > 0 || project.attentionCounts.pending > 0) return "yellow";
  if (project.activeCount > 0) return "green";
  return "gray";
}

const healthColor: Record<ProjectHealth, string> = {
  red: "var(--color-status-error)",
  yellow: "var(--color-status-attention)",
  green: "var(--color-status-ready)",
  gray: "var(--color-text-tertiary)",
};

function ProjectRailContent({ projects, compact = false }: { projects: PortfolioProjectSummary[]; compact?: boolean }) {
  const activeCount = projects.reduce((sum, project) => sum + project.activeCount, 0);
  const reviewCount = projects.reduce(
    (sum, project) => sum + project.attentionCounts.review + project.attentionCounts.pending,
    0,
  );
  const respondCount = projects.reduce((sum, project) => sum + project.attentionCounts.respond, 0);

  return (
    <>
      <div className={cn("border-b border-[var(--color-border-subtle)]", compact ? "px-4 py-4" : "px-4 pb-3 pt-4")}>
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
          Portfolio
        </div>
        <div className="mt-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[17px] font-semibold text-[var(--color-text-primary)]">Projects</h2>
            <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
              Human attention across your repos.
            </p>
          </div>
          <div className="rounded-full border border-[var(--color-border-default)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            {projects.length}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <RailMetric label="Active" value={activeCount} />
          <RailMetric label="Review" value={reviewCount} tone="var(--color-status-attention)" />
          <RailMetric label="Respond" value={respondCount} tone="var(--color-status-error)" />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Project navigation">
        <a
          href="/"
          className="flex min-h-[44px] w-full items-center gap-2 rounded-xl px-3 py-3 text-left text-[12px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:no-underline"
        >
          <svg
            className="h-3.5 w-3.5 shrink-0 opacity-60"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
          >
            <path d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
          </svg>
          <span className="min-w-0 flex-1 truncate">All Projects</span>
        </a>

        <div className="mx-2 my-2 border-t border-[var(--color-border-subtle)]" />

        <div className="space-y-1">
          {projects.map((project) => {
            const health = getProjectHealth(project);
            const count = project.degraded
              ? "!"
              : project.attentionCounts.respond +
                project.attentionCounts.review +
                project.attentionCounts.merge;

            return (
              <a
                key={project.id}
                href={`/projects/${encodeURIComponent(project.id)}`}
                className="flex min-h-[44px] items-center gap-2 rounded-xl px-3 py-3 text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-primary)] hover:no-underline"
              >
                <span
                  className={cn(
                    "h-2.5 w-2.5 shrink-0 rounded-full",
                    health === "red" && "animate-[activity-pulse_2s_ease-in-out_infinite]",
                  )}
                  style={{ background: healthColor[health] }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <span className="rounded-full border border-[var(--color-border-subtle)] px-1.5 py-px text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
                  {count}
                </span>
              </a>
            );
          })}
        </div>
      </nav>
    </>
  );
}

function RailMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div
        className="mt-1 text-[18px] font-semibold tabular-nums text-[var(--color-text-primary)]"
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

export function ProjectRail({ projects, mobileOpen = false, onMobileClose }: ProjectRailProps) {
  return (
    <>
      <aside className="hidden h-screen w-[262px] shrink-0 border-r border-[var(--color-border-default)] bg-[var(--color-bg-surface)] lg:flex lg:flex-col">
        <ProjectRailContent projects={projects} />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" aria-modal="true" role="dialog">
          <button
            type="button"
            className="absolute inset-0 bg-[rgba(5,8,14,0.6)]"
            aria-label="Close project switcher"
            onClick={onMobileClose}
          />
          <div className="absolute inset-y-0 left-0 flex w-[88vw] max-w-[320px] flex-col border-r border-[var(--color-border-default)] bg-[var(--color-bg-surface)] shadow-[0_24px_64px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                Projects
              </span>
              <button
                type="button"
                className="rounded-full border border-[var(--color-border-default)] p-2 text-[var(--color-text-secondary)]"
                onClick={onMobileClose}
                aria-label="Close project switcher"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <ProjectRailContent projects={projects} compact />
          </div>
        </div>
      ) : null}
    </>
  );
}
