"use client";

import type { ProjectInfo } from "@/lib/project-name";
import type { DashboardSession, DashboardOrchestratorLink } from "@/lib/types";
import { getProjectScopedHref } from "@/lib/project-utils";

interface ProjectSummary {
  project: ProjectInfo;
  sessionCount: number;
  activeCount: number;
  needsAttentionCount: number;
  orchestrator?: DashboardOrchestratorLink;
}

interface PortfolioPageProps {
  projects: ProjectInfo[];
  sessions: DashboardSession[];
  orchestrators: DashboardOrchestratorLink[];
}

export function PortfolioPage({
  projects,
  sessions,
  orchestrators,
}: PortfolioPageProps) {
  const summaries: ProjectSummary[] = projects.map((project) => {
    const projectSessions = sessions.filter((s) => s.projectId === project.id);
    const activeCount = projectSessions.filter(
      (s) => s.activity === "active" || s.activity === "ready",
    ).length;
    const needsAttentionCount = projectSessions.filter(
      (s) =>
        s.status === "ci_failed" ||
        s.status === "changes_requested" ||
        s.status === "needs_input" ||
        s.status === "stuck" ||
        s.status === "errored",
    ).length;
    const orchestrator = orchestrators.find((o) => o.projectId === project.id);

    return {
      project,
      sessionCount: projectSessions.length,
      activeCount,
      needsAttentionCount,
      orchestrator,
    };
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">All Projects</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {summaries.map((summary) => (
          <a
            key={summary.project.id}
            href={getProjectScopedHref("/", summary.project.id)}
            className="block p-5 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:border-neutral-400 dark:hover:border-neutral-500 transition-colors bg-white dark:bg-neutral-900"
          >
            <h2 className="text-lg font-semibold truncate">
              {summary.project.name}
            </h2>
            <div className="mt-3 flex flex-wrap gap-3 text-sm text-neutral-500 dark:text-neutral-400">
              <span>
                {summary.sessionCount} session
                {summary.sessionCount !== 1 ? "s" : ""}
              </span>
              {summary.activeCount > 0 && (
                <span className="text-green-600 dark:text-green-400">
                  {summary.activeCount} active
                </span>
              )}
              {summary.needsAttentionCount > 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  {summary.needsAttentionCount} need attention
                </span>
              )}
            </div>
            {summary.orchestrator && (
              <div className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
                Orchestrator: {summary.orchestrator.sessionId}
              </div>
            )}
          </a>
        ))}
      </div>
      {summaries.length === 0 && (
        <p className="text-neutral-500 dark:text-neutral-400">
          No projects registered. Run{" "}
          <code className="px-1 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-sm">
            ao start
          </code>{" "}
          to add a project.
        </p>
      )}
    </div>
  );
}
