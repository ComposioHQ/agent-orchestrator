"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useDashboardShellControls } from "./DashboardShell";
import type { AttentionLevel, PortfolioProjectSummary } from "@/lib/types";

interface PortfolioPageProps {
  projectSummaries: PortfolioProjectSummary[];
  onOpenProject?: () => void;
  onCloneFromUrl?: () => void;
}

/** Attention levels that require human action, ordered by urgency */
const ACTIVE_LEVELS: AttentionLevel[] = ["merge", "respond", "review", "pending", "working"];

export function PortfolioPage({
  projectSummaries,
  onOpenProject,
  onCloneFromUrl,
}: PortfolioPageProps) {
  const controls = useDashboardShellControls();
  const openProject = onOpenProject ?? controls?.openAddProject ?? (() => {});
  const cloneFromUrl = onCloneFromUrl ?? controls?.openCloneFromUrl ?? (() => {});

  const totalSessions = projectSummaries.reduce((s, p) => s + p.sessionCount, 0);
  const hasProjects = projectSummaries.length > 0 && totalSessions > 0;

  if (hasProjects) {
    return <AttentionHome projectSummaries={projectSummaries} />;
  }

  return <LauncherHome
    projectSummaries={projectSummaries}
    openProject={openProject}
    cloneFromUrl={cloneFromUrl}
  />;
}

// ---------------------------------------------------------------------------
// Attention-first home — for returning users with sessions
// ---------------------------------------------------------------------------

function AttentionHome({ projectSummaries }: { projectSummaries: PortfolioProjectSummary[] }) {
  const totalActive = projectSummaries.reduce((s, p) => s + p.activeCount, 0);
  const totalSessions = projectSummaries.reduce((s, p) => s + p.sessionCount, 0);

  // Aggregate attention counts across all projects
  const globalCounts: Record<AttentionLevel, number> = {
    merge: 0, respond: 0, review: 0, pending: 0, working: 0, done: 0,
  };
  for (const p of projectSummaries) {
    for (const level of ACTIVE_LEVELS) {
      globalCounts[level] += p.attentionCounts[level] ?? 0;
    }
    globalCounts.done += p.attentionCounts.done ?? 0;
  }

  return (
    <main className="min-h-screen bg-[var(--color-bg-base)] px-6 py-12 text-[var(--color-text-primary)]">
      <div className="mx-auto w-full max-w-[960px]">
        {/* Header */}
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[22px] font-bold tracking-[-0.025em]">
              Portfolio
            </h1>
            <p className="mt-1 text-[var(--font-size-sm)] text-[var(--color-text-tertiary)]">
              {totalActive} active of {totalSessions} sessions across {projectSummaries.length} workspace{projectSummaries.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        {/* Attention summary pills */}
        <div className="mt-6 flex flex-wrap gap-3">
          {ACTIVE_LEVELS.map((level) => {
            const count = globalCounts[level];
            if (count === 0) return null;
            return (
              <div
                key={level}
                className="flex items-center gap-2 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-3 py-1.5"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: LEVEL_COLORS[level] }}
                />
                <span className="font-[var(--font-mono)] text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-secondary)]">
                  {count} {level}
                </span>
              </div>
            );
          })}
          {totalActive === 0 && (
            <p className="text-[var(--font-size-sm)] text-[var(--color-text-tertiary)]">
              All sessions complete. Fleet is idle.
            </p>
          )}
        </div>

        {/* Project cards */}
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projectSummaries.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      </div>
    </main>
  );
}

function ProjectCard({ project }: { project: PortfolioProjectSummary }) {
  const activeLevels = ACTIVE_LEVELS.filter(
    (l) => (project.attentionCounts[l] ?? 0) > 0,
  );

  return (
    <Link
      href={`/projects/${encodeURIComponent(project.id)}`}
      className="group flex flex-col rounded-[2px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4 shadow-[var(--card-shadow)] transition duration-150 hover:border-[var(--color-border-default)] hover:shadow-[var(--card-shadow-hover)]"
    >
      <div className="flex items-center justify-between">
        <span className="text-[var(--font-size-base)] font-medium tracking-[-0.015em] text-[var(--color-text-primary)]">
          {project.name}
        </span>
        <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
          {project.activeCount}/{project.sessionCount}
        </span>
      </div>

      {project.repo && (
        <span className="mt-1 font-[var(--font-mono)] text-[10px] text-[var(--color-text-tertiary)]">
          {project.repo}
        </span>
      )}

      {activeLevels.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {activeLevels.map((level) => (
            <span
              key={level}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.04em]"
              style={{
                backgroundColor: `${LEVEL_COLORS[level]}18`,
                color: LEVEL_COLORS[level],
              }}
            >
              {project.attentionCounts[level]} {level}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-[10px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
          Idle
        </p>
      )}
    </Link>
  );
}

const LEVEL_COLORS: Record<AttentionLevel, string> = {
  merge: "#22c55e",
  respond: "#f1be64",
  review: "#06b6d4",
  pending: "#5B7EF8",
  working: "#22c55e",
  done: "#3a4252",
};

// ---------------------------------------------------------------------------
// Launcher home — for new users or empty portfolios
// ---------------------------------------------------------------------------

function LauncherHome({
  projectSummaries,
  openProject,
  cloneFromUrl,
}: {
  projectSummaries: PortfolioProjectSummary[];
  openProject: () => void;
  cloneFromUrl: () => void;
}) {
  const workspaceCount = projectSummaries.length;
  const workspaceLabel = `${workspaceCount} workspace${workspaceCount === 1 ? "" : "s"} available`;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg-base)] px-6 py-16 text-[var(--color-text-primary)]">
      <div className="flex w-full max-w-[760px] flex-col items-center">
        <div className="mt-10 text-center">
          <h1 className="text-[28px] font-bold tracking-[-0.025em] text-[var(--color-text-primary)] sm:text-[36px] sm:leading-[1.1]">
            Agent Orchestrator
          </h1>
          <p className="mx-auto mt-5 max-w-[38ch] text-[var(--font-size-base)] leading-relaxed text-[var(--color-text-secondary)] sm:text-[var(--font-size-lg)]">
            Open a workspace or clone a repo from the same portfolio home.
          </p>
        </div>

        <div className="mt-14 grid w-full gap-3 sm:grid-cols-2">
          <LauncherCard
            label="Open project"
            description="Register an existing local workspace."
            onClick={openProject}
            icon={<OpenProjectIcon />}
          />
          <LauncherCard
            label="Clone from URL"
            description="Clone a repository into your workspace root."
            onClick={cloneFromUrl}
            icon={<CloneIcon />}
          />
        </div>

        <div className="mt-8 flex items-center gap-2 text-[var(--font-size-sm)] text-[var(--color-text-tertiary)]">
          <FolderStatusIcon />
          <span>{workspaceLabel}</span>
        </div>
      </div>
    </main>
  );
}

function LauncherCard({
  label,
  description,
  onClick,
  icon,
}: {
  label: string;
  description: string;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[154px] flex-col rounded-[2px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4 text-left shadow-[var(--card-shadow)] transition duration-150 hover:border-[var(--color-border-default)] hover:shadow-[var(--card-shadow-hover)]"
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] text-[var(--color-text-secondary)] transition-colors group-hover:text-[var(--color-text-primary)]">
        {icon}
      </div>
      <div className="mt-auto">
        <div className="text-[var(--font-size-xl)] font-medium tracking-[-0.025em] text-[var(--color-text-primary)]">
          {label}
        </div>
        <p className="mt-2 text-[var(--font-size-base)] leading-snug text-[var(--color-text-secondary)]">
          {description}
        </p>
      </div>
    </button>
  );
}

function OpenProjectIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M4.75 7.75A2.25 2.25 0 0 1 7 5.5h3.4l1.55 1.75H17a2.25 2.25 0 0 1 2.25 2.25v6.75A2.25 2.25 0 0 1 17 18.5H7a2.25 2.25 0 0 1-2.25-2.25Z" />
    </svg>
  );
}

function CloneIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="7.25" />
      <path d="M12 4.75c2.4 2.05 3.6 4.48 3.6 7.25S14.4 17.2 12 19.25M12 4.75c-2.4 2.05-3.6 4.48-3.6 7.25S9.6 17.2 12 19.25M4.75 12h14.5" />
    </svg>
  );
}

function FolderStatusIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M4.75 7.75A2.25 2.25 0 0 1 7 5.5h3.4l1.55 1.75H17a2.25 2.25 0 0 1 2.25 2.25v6.75A2.25 2.25 0 0 1 17 18.5H7a2.25 2.25 0 0 1-2.25-2.25Z" />
      <path d="M8.5 12.5h7" />
    </svg>
  );
}
