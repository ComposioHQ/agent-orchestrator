"use client";

import { useMemo } from "react";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import {
  type DashboardSession,
  type DashboardPR,
  type DashboardOrchestratorLink,
  getAttentionLevel,
} from "@/lib/types";
import { useSessionEvents } from "@/hooks/useSessionEvents";

import { DynamicFavicon } from "./DynamicFavicon";
import { PRCard, PRTableRow } from "./PRStatus";
import { MobileBottomNav } from "./MobileBottomNav";
import type { ProjectInfo } from "@/lib/project-name";
import { getProjectScopedHref, getProjectSessionHref } from "@/lib/project-utils";

interface PullRequestsPageProps {
  initialSessions: DashboardSession[];
  projectId?: string;
  projectName?: string;
  projects?: ProjectInfo[];
  orchestrators?: DashboardOrchestratorLink[];
}

const EMPTY_ORCHESTRATORS: DashboardOrchestratorLink[] = [];

export function PullRequestsPage({
  initialSessions,
  projectId,
  projectName,
  projects = [],
  orchestrators,
}: PullRequestsPageProps) {
  const orchestratorLinks = orchestrators ?? EMPTY_ORCHESTRATORS;
  const initialAttentionLevels = useMemo(() => {
    const levels: Record<string, ReturnType<typeof getAttentionLevel>> = {};
    for (const s of initialSessions) {
      levels[s.id] = getAttentionLevel(s);
    }
    return levels;
  }, [initialSessions]);
  const { sessions, sseAttentionLevels } = useSessionEvents(initialSessions, null, projectId, initialAttentionLevels);
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const allProjectsView = projects.length > 1 && projectId === undefined;
  const currentProjectOrchestrator = useMemo(
    () =>
      projectId
        ? orchestratorLinks.find((orchestrator) => orchestrator.projectId === projectId) ?? null
        : null,
    [orchestratorLinks, projectId],
  );
  const openPRs = useMemo(() => {
    return sessions
      .filter(
        (session): session is DashboardSession & { pr: DashboardPR } => session.pr?.state === "open",
      )
      .map((session) => session.pr)
      .sort((a, b) => a.number - b.number);
  }, [sessions]);
  const dashboardHref = getProjectScopedHref("/", projectId);
  const prsHref = getProjectScopedHref("/prs", projectId);
  const orchestratorHref = currentProjectOrchestrator
    ? getProjectSessionHref(currentProjectOrchestrator.projectId, currentProjectOrchestrator.id)
    : null;

  return (
    <div className="dashboard-shell flex h-screen">
      <div className="dashboard-main flex-1 overflow-y-auto px-4 py-4 md:px-7 md:py-6">
        <DynamicFavicon sseAttentionLevels={sseAttentionLevels} projectName={projectName ? `${projectName} PRs` : "Pull Requests"} />
        <section className="dashboard-hero mb-5">
          <div className="dashboard-hero__backdrop" />
          <div className="dashboard-hero__content">
            <div className="dashboard-hero__primary">
              <div className="dashboard-hero__heading">
                <div>
                  <h1 className="dashboard-title">{projectName ? `${projectName} PRs` : "Pull Requests"}</h1>
                  <p className="dashboard-subtitle">
                    Review active pull requests without the dashboard board chrome.
                  </p>
                </div>
              </div>
              <div className="dashboard-stat-cards dashboard-stat-cards--persist-mobile">
                <div className="dashboard-stat-card">
                  <span className="dashboard-stat-card__value">{openPRs.length}</span>
                  <span className="dashboard-stat-card__label">Open PRs</span>
                  <span className="dashboard-stat-card__meta">
                    {allProjectsView ? "Across all projects" : "In this project"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[900px]">
          <h2 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Pull Requests
          </h2>
          {openPRs.length === 0 ? (
            <div className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 py-6 text-[12px] text-[var(--color-text-secondary)]">
              No open pull requests right now.
            </div>
          ) : isMobile ? (
            <div className="mobile-pr-list">
              {openPRs.map((pr) => (
                <PRCard key={`${pr.owner}/${pr.repo}-${pr.number}`} pr={pr} />
              ))}
            </div>
          ) : (
            <div className="overflow-hidden border border-[var(--color-border-default)]">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border-muted)]">
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      PR
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Title
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Size
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      CI
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Review
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Unresolved
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {openPRs.map((pr) => (
                    <PRTableRow key={`${pr.owner}/${pr.repo}-${pr.number}`} pr={pr} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {isMobile ? (
        <MobileBottomNav
          ariaLabel="PR navigation"
          activeTab="prs"
          dashboardHref={dashboardHref}
          prsHref={prsHref}
          showOrchestrator={!allProjectsView}
          orchestratorHref={orchestratorHref}
        />
      ) : null}
    </div>
  );
}
