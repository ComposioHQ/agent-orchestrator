"use client";

import type { ReactNode } from "react";
import { useDashboardShellControls } from "./DashboardShell";

interface PortfolioPageProps {
  projectSummaries: Array<{ id: string; name: string }>;
  onOpenProject?: () => void;
  onCloneFromUrl?: () => void;
  onQuickStart?: () => void;
}

export function PortfolioPage({
  projectSummaries,
  onOpenProject,
  onCloneFromUrl,
  onQuickStart,
}: PortfolioPageProps) {
  const controls = useDashboardShellControls();
  const openProject = onOpenProject ?? controls?.openAddProject ?? (() => {});
  const cloneFromUrl = onCloneFromUrl ?? controls?.openCloneFromUrl ?? (() => {});
  const quickStart = onQuickStart ?? controls?.openQuickStart ?? (() => {});
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
            Open a workspace, clone a repo, or start a fresh project from the same portfolio home.
          </p>
        </div>

        <div className="mt-14 grid w-full gap-3 sm:grid-cols-3">
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
          <LauncherCard
            label="Quick start"
            description="Create an empty or Next.js project locally."
            onClick={quickStart}
            icon={<QuickStartIcon />}
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
      className="group flex min-h-[154px] flex-col rounded-none border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4 text-left shadow-[var(--card-shadow)] transition duration-150 hover:border-[var(--color-border-default)] hover:shadow-[var(--card-shadow-hover)]"
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

function QuickStartIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M6.75 5.75h10.5A1.75 1.75 0 0 1 19 7.5v9a1.75 1.75 0 0 1-1.75 1.75H6.75A1.75 1.75 0 0 1 5 16.5v-9a1.75 1.75 0 0 1 1.75-1.75Z" />
      <path d="M12 9v6M9 12h6" />
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
