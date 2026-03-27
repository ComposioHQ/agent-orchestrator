"use client";

import { useMemo, useState } from "react";
import { usePortfolioEvents } from "@/hooks/usePortfolioEvents";
import {
  getTriageRank,
  type AttentionLevel,
  type PortfolioActionItem,
  type PortfolioProjectSummary,
} from "@/lib/types";
import { ProjectRail } from "./ProjectRail";

interface PortfolioPageProps {
  actionItems: PortfolioActionItem[];
  projectSummaries: PortfolioProjectSummary[];
}

interface ProjectPanelData {
  summary: PortfolioProjectSummary;
  dominantLevel: AttentionLevel | null;
  dominantLabel: string;
  dominantBody: string;
  sortRank: number;
  latestActivityAt: number;
}

const COUNT_LEVELS: Array<{ key: AttentionLevel; label: string }> = [
  { key: "working", label: "Working" },
  { key: "pending", label: "Pending" },
  { key: "review", label: "Review" },
  { key: "respond", label: "Respond" },
  { key: "merge", label: "Ready" },
];

const LEVEL_STYLES: Record<AttentionLevel, { label: string; tone: string; tint: string }> = {
  respond: {
    label: "Needs your input",
    tone: "var(--color-status-error)",
    tint: "var(--color-tint-red)",
  },
  review: {
    label: "Needs review",
    tone: "var(--color-accent-orange)",
    tint: "var(--color-tint-orange)",
  },
  merge: {
    label: "Ready to land",
    tone: "var(--color-status-ready)",
    tint: "var(--color-tint-green)",
  },
  pending: {
    label: "Waiting on the system",
    tone: "var(--color-status-attention)",
    tint: "var(--color-tint-yellow)",
  },
  working: {
    label: "Agents are moving",
    tone: "var(--color-status-working)",
    tint: "var(--color-tint-blue)",
  },
  done: {
    label: "All quiet",
    tone: "var(--color-text-tertiary)",
    tint: "var(--color-tint-neutral)",
  },
};

function describeDominantState(summary: PortfolioProjectSummary, dominantLevel: AttentionLevel | null) {
  if (summary.degraded) {
    return {
      label: "Needs repair",
      body: summary.degradedReason ?? "This project is registered, but its config could not be loaded.",
      rank: -1,
    };
  }

  if (dominantLevel === null || summary.activeCount === 0) {
    return {
      label: "All quiet",
      body: "Nothing currently needs human judgment in this project.",
      rank: 6,
    };
  }

  if (summary.attentionCounts.respond > 0) {
    return {
      label: LEVEL_STYLES.respond.label,
      body: `${summary.attentionCounts.respond} session${summary.attentionCounts.respond === 1 ? "" : "s"} waiting for human input.`,
      rank: getTriageRank("respond"),
    };
  }

  if (summary.attentionCounts.review > 0) {
    return {
      label: LEVEL_STYLES.review.label,
      body: `${summary.attentionCounts.review} session${summary.attentionCounts.review === 1 ? "" : "s"} need investigation or review.`,
      rank: getTriageRank("review"),
    };
  }

  if (summary.attentionCounts.merge > 0) {
    return {
      label: LEVEL_STYLES.merge.label,
      body: `${summary.attentionCounts.merge} pull request${summary.attentionCounts.merge === 1 ? "" : "s"} can be landed now.`,
      rank: getTriageRank("merge"),
    };
  }

  if (summary.attentionCounts.pending > 0) {
    return {
      label: LEVEL_STYLES.pending.label,
      body: `${summary.attentionCounts.pending} session${summary.attentionCounts.pending === 1 ? "" : "s"} waiting on reviewers or CI.`,
      rank: getTriageRank("pending"),
    };
  }

  return {
    label: LEVEL_STYLES.working.label,
    body: `${summary.attentionCounts.working} session${summary.attentionCounts.working === 1 ? "" : "s"} still running without needing you.`,
    rank: getTriageRank("working"),
  };
}

function buildPortfolioSummary(projects: ProjectPanelData[]) {
  const degradedCount = projects.filter((project) => project.summary.degraded).length;
  const urgentProjects = projects.filter(
    (project) =>
      !project.summary.degraded &&
      (project.summary.attentionCounts.respond > 0 ||
        project.summary.attentionCounts.review > 0 ||
        project.summary.attentionCounts.merge > 0),
  ).length;
  const activeProjects = projects.filter((project) => project.summary.activeCount > 0).length;
  const activeSessions = projects.reduce((sum, project) => sum + project.summary.activeCount, 0);
  const projectCount = projects.length;

  if (projectCount === 0) {
    return "Register a project to turn AO into a portfolio-level attention center.";
  }

  if (degradedCount > 0) {
    return `${degradedCount} project${degradedCount === 1 ? "" : "s"} need repair, ${urgentProjects} ${
      urgentProjects === 1 ? "project needs" : "projects need"
    } judgment right now.`;
  }

  if (urgentProjects > 0) {
    return `${urgentProjects} ${urgentProjects === 1 ? "project needs" : "projects need"} your judgment now, with ${activeSessions} active session${activeSessions === 1 ? "" : "s"} across ${projectCount} project${projectCount === 1 ? "" : "s"}.`;
  }

  if (activeProjects > 0) {
    return `Nothing currently needs human judgment. ${activeSessions} active session${activeSessions === 1 ? "" : "s"} are still moving across ${projectCount} project${projectCount === 1 ? "" : "s"}.`;
  }

  return `Nothing currently needs human judgment across ${projectCount} project${projectCount === 1 ? "" : "s"}.`;
}

export function PortfolioPage({
  actionItems: initialActionItems,
  projectSummaries: initialProjectSummaries,
}: PortfolioPageProps) {
  const { actionItems, projectSummaries } = usePortfolioEvents(
    initialActionItems,
    initialProjectSummaries,
  );
  const [mobileRailOpen, setMobileRailOpen] = useState(false);

  const panels = useMemo<ProjectPanelData[]>(() => {
    const itemsByProject = new Map<string, PortfolioActionItem[]>();
    for (const item of actionItems) {
      const projectItems = itemsByProject.get(item.projectId) ?? [];
      projectItems.push(item);
      itemsByProject.set(item.projectId, projectItems);
    }

    return projectSummaries
      .map((summary) => {
        const items = itemsByProject.get(summary.id) ?? [];
        const dominantItem = items[0] ?? null;
        const dominantLevel = dominantItem?.attentionLevel ?? null;
        const latestActivityAt =
          items.length > 0
            ? Math.max(...items.map((item) => new Date(item.session.lastActivityAt).getTime()))
            : 0;
        const descriptor = describeDominantState(summary, dominantLevel);

        return {
          summary,
          dominantLevel,
          dominantLabel: descriptor.label,
          dominantBody: descriptor.body,
          sortRank: descriptor.rank,
          latestActivityAt,
        };
      })
      .sort((left, right) => {
        if (left.sortRank !== right.sortRank) return left.sortRank - right.sortRank;
        if (left.latestActivityAt !== right.latestActivityAt) {
          return right.latestActivityAt - left.latestActivityAt;
        }
        return left.summary.name.localeCompare(right.summary.name);
      });
  }, [actionItems, projectSummaries]);

  const counts = useMemo(
    () => ({
      respond: panels.reduce((sum, panel) => sum + panel.summary.attentionCounts.respond, 0),
      review: panels.reduce((sum, panel) => sum + panel.summary.attentionCounts.review, 0),
      ready: panels.reduce((sum, panel) => sum + panel.summary.attentionCounts.merge, 0),
    }),
    [panels],
  );

  const summaryLine = useMemo(() => buildPortfolioSummary(panels), [panels]);
  const isQuiet = counts.respond === 0 && counts.review === 0 && counts.ready === 0;

  if (panels.length === 0) {
    return (
      <div className="min-h-screen bg-[var(--color-bg-base)] text-[var(--color-text-primary)]">
        <div className="mx-auto flex min-h-screen w-full max-w-[880px] items-center px-5 py-10">
          <section className="w-full rounded-[28px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-8 shadow-[0_24px_70px_rgba(0,0,0,0.18)]">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
              Portfolio
            </div>
            <h1 className="mt-4 text-[30px] font-semibold leading-tight text-[var(--color-text-primary)]">
              Register your first project
            </h1>
            <p className="mt-3 max-w-[58ch] text-[15px] leading-7 text-[var(--color-text-secondary)]">
              AO stays quiet until work needs your judgment. Start a project once, and this
              page becomes your portfolio-level attention center.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a
                href="https://github.com/ComposioHQ/agent-orchestrator?tab=readme-ov-file#quick-start"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-[var(--color-accent)] px-4 py-2.5 text-[13px] font-semibold text-[var(--color-text-inverse)] hover:opacity-90 hover:no-underline"
              >
                Open setup guide
              </a>
              <code className="rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
                ao start
              </code>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg-base)] text-[var(--color-text-primary)] lg:flex">
      <ProjectRail
        projects={projectSummaries}
        mobileOpen={mobileRailOpen}
        onMobileClose={() => setMobileRailOpen(false)}
      />

      <main className="min-w-0 flex-1">
        <div className="mx-auto flex min-h-screen w-full max-w-[1180px] flex-col px-4 pb-10 pt-4 sm:px-5 lg:px-8 lg:pt-7">
          <header className="rounded-[30px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-5 py-5 shadow-[0_24px_70px_rgba(0,0,0,0.16)] sm:px-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                  Portfolio
                </div>
                <h1 className="mt-3 text-[26px] font-semibold leading-tight text-[var(--color-text-primary)] sm:text-[34px]">
                  Human attention across your projects
                </h1>
                <p className="mt-3 max-w-[62ch] text-[14px] leading-7 text-[var(--color-text-secondary)] sm:text-[15px]">
                  {summaryLine}
                </p>
              </div>

              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-2 rounded-full border border-[var(--color-border-default)] px-3 py-2 text-[12px] font-medium text-[var(--color-text-secondary)] lg:hidden"
                onClick={() => setMobileRailOpen(true)}
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                >
                  <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
                Projects
              </button>
            </div>

            <div className="mt-5 flex flex-wrap gap-2.5">
              <SummaryPill label="Respond" value={counts.respond} tone="var(--color-status-error)" />
              <SummaryPill label="Review" value={counts.review} tone="var(--color-accent-orange)" />
              <SummaryPill label="Ready" value={counts.ready} tone="var(--color-status-ready)" />
            </div>
          </header>

          {isQuiet ? (
            <section className="mt-5 rounded-[26px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-5 py-4 sm:px-6">
              <p className="text-[14px] font-medium text-[var(--color-text-primary)]">
                Nothing currently needs human judgment.
              </p>
              <p className="mt-1 text-[13px] leading-6 text-[var(--color-text-secondary)]">
                Keep an eye on the project panels below. AO will stay quiet until something
                needs review, a reply, or a landing decision.
              </p>
            </section>
          ) : null}

          <section className="mt-6 grid gap-4 xl:grid-cols-2" aria-label="Portfolio projects">
            {panels.map((panel) => (
              <ProjectPanel key={panel.summary.id} panel={panel} />
            ))}
          </section>
        </div>
      </main>
    </div>
  );
}

function SummaryPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[12px]">
      <span className="font-medium text-[var(--color-text-secondary)]">{label}</span>
      <span className="font-semibold tabular-nums" style={{ color: tone }}>
        {value}
      </span>
    </div>
  );
}

function ProjectPanel({ panel }: { panel: ProjectPanelData }) {
  const { summary, dominantLevel, dominantLabel, dominantBody } = panel;
  const style =
    dominantLevel !== null ? LEVEL_STYLES[dominantLevel] : LEVEL_STYLES.done;
  const href = `/projects/${encodeURIComponent(summary.id)}`;

  return (
    <a
      href={href}
      className="group block rounded-[28px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)] transition-transform duration-150 hover:-translate-y-[1px] hover:no-underline"
      aria-label={`Open ${summary.name} board`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div
            className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em]"
            style={{ color: style.tone, background: style.tint }}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: style.tone }}
              aria-hidden="true"
            />
            {summary.degraded ? "Needs repair" : dominantLabel}
          </div>
          <h2 className="mt-4 text-[20px] font-semibold text-[var(--color-text-primary)]">
            {summary.name}
          </h2>
          <p className="mt-2 max-w-[58ch] text-[14px] leading-6 text-[var(--color-text-secondary)]">
            {dominantBody}
          </p>
        </div>
        <div className="rounded-full border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          {summary.sessionCount} session{summary.sessionCount === 1 ? "" : "s"}
        </div>
      </div>

      {summary.degraded ? (
        <div className="mt-5 rounded-[20px] border border-[color-mix(in_srgb,var(--color-status-error)_20%,transparent)] bg-[var(--color-tint-red)] px-4 py-3">
          <p className="text-[12px] font-semibold text-[var(--color-status-error)]">
            Repair this project
          </p>
          <p className="mt-1 text-[12px] leading-6 text-[var(--color-text-secondary)]">
            Open the project page to inspect the broken config and restore visibility.
          </p>
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {COUNT_LEVELS.map(({ key, label }) => (
            <CountTile
              key={key}
              label={label}
              value={summary.attentionCounts[key]}
              tone={LEVEL_STYLES[key].tone}
            />
          ))}
        </div>
      )}

      <div className="mt-5 flex items-center justify-between text-[12px] text-[var(--color-text-secondary)]">
        <span>
          {summary.activeCount > 0
            ? `${summary.activeCount} active session${summary.activeCount === 1 ? "" : "s"}`
            : "No active sessions"}
        </span>
        <span className="inline-flex items-center gap-2 font-medium text-[var(--color-text-primary)]">
          Open board
          <svg
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        </span>
      </div>
    </a>
  );
}

function CountTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded-[18px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-1 text-[18px] font-semibold tabular-nums" style={{ color: tone }}>
        {value}
      </div>
    </div>
  );
}
