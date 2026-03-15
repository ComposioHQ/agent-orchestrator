import type { ReactNode } from "react";
import type {
  DashboardOrchestratorLink,
  DashboardStats,
  DashboardView,
  GlobalPauseState,
} from "@/lib/types";
import type { DashboardTrust } from "../Dashboard";
import { DashboardModeSwitcher } from "./DashboardModeSwitcher";

interface DashboardShellProps {
  allProjectsView: boolean;
  anyRateLimited: boolean;
  children: ReactNode;
  dashboardTrust: DashboardTrust;
  globalPause: GlobalPauseState | null;
  globalPauseDismissed: boolean;
  onDismissGlobalPause: () => void;
  onDismissRateLimit: () => void;
  onRefreshNow: () => void;
  orchestrators: DashboardOrchestratorLink[];
  projectId?: string;
  projectName?: string;
  rateLimitDismissed: boolean;
  resumeAtLabel: string | null;
  stats: DashboardStats;
  view: DashboardView;
}

export function DashboardShell({
  allProjectsView,
  anyRateLimited,
  children,
  dashboardTrust,
  globalPause,
  globalPauseDismissed,
  onDismissGlobalPause,
  onDismissRateLimit,
  onRefreshNow,
  orchestrators,
  projectName,
  rateLimitDismissed,
  resumeAtLabel,
  stats,
  view,
}: DashboardShellProps) {
  return (
    <>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-6">
        <div className="flex items-center gap-6">
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
              Shared Dashboard Shell
            </div>
            <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-[var(--color-text-primary)]">
              {projectName ?? "Orchestrator"}
            </h1>
            <StatusLine stats={stats} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <DashboardModeSwitcher view={view} />
          {!allProjectsView && <OrchestratorControl orchestrators={orchestrators} />}
        </div>
      </div>

      {globalPause && !globalPauseDismissed && (
        <Banner
          accent="border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.05)] text-[var(--color-status-error)]"
          onDismiss={onDismissGlobalPause}
        >
          <strong>Orchestrator paused:</strong> {globalPause.reason}
          {resumeAtLabel && <span className="ml-2 opacity-75">Resume after {resumeAtLabel}</span>}
          {globalPause.sourceSessionId && (
            <span className="ml-2 opacity-75">(Source: {globalPause.sourceSessionId})</span>
          )}
        </Banner>
      )}

      {anyRateLimited && !rateLimitDismissed && (
        <Banner
          accent="border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.05)] text-[var(--color-status-attention)]"
          onDismiss={onDismissRateLimit}
        >
          GitHub API rate limited. PR data may be stale and will refresh automatically.
        </Banner>
      )}

      {dashboardTrust.alignment.status !== "aligned" && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded border border-[rgba(96,165,250,0.25)] bg-[rgba(37,99,235,0.08)] px-3.5 py-3 text-[11px] text-[rgba(191,219,254,0.92)]">
          <div className="space-y-1">
            <div className="font-semibold uppercase tracking-[0.12em]">
              {dashboardTrust.alignment.status === "drifted"
                ? "Alignment drift visible"
                : "Live refresh settling"}
            </div>
            <div>
              Shared shell and pixel mode are rechecking counts for{" "}
              {dashboardTrust.alignment.expectedMembershipCount} session
              {dashboardTrust.alignment.expectedMembershipCount === 1 ? "" : "s"}.
              {dashboardTrust.alignment.affectedLevels.length > 0
                ? ` Affected lanes: ${dashboardTrust.alignment.affectedLevels.join(", ")}.`
                : " Membership is changing."}
            </div>
          </div>
          <button
            type="button"
            onClick={onRefreshNow}
            className="rounded-[8px] border border-[rgba(147,197,253,0.35)] px-3 py-1.5 text-[11px] font-semibold text-[rgba(219,234,254,0.96)]"
          >
            Recheck now
          </button>
        </div>
      )}

      {children}
    </>
  );
}

function Banner({
  accent,
  children,
  onDismiss,
}: {
  accent: string;
  children: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div className={`mb-6 flex items-center gap-2.5 rounded border px-3.5 py-2.5 text-[11px] ${accent}`}>
      <svg
        className="h-3.5 w-3.5 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <span className="flex-1">{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-1 shrink-0 opacity-60 hover:opacity-100"
        aria-label="Dismiss"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function OrchestratorControl({ orchestrators }: { orchestrators: DashboardOrchestratorLink[] }) {
  if (orchestrators.length === 0) return null;

  if (orchestrators.length === 1) {
    const orchestrator = orchestrators[0];
    return (
      <a
        href={`/sessions/${encodeURIComponent(orchestrator.id)}`}
        className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-4 py-2 text-[12px] font-semibold hover:no-underline"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
        orchestrator
      </a>
    );
  }

  return (
    <details className="group relative">
      <summary className="orchestrator-btn flex cursor-pointer list-none items-center gap-2 rounded-[7px] px-4 py-2 text-[12px] font-semibold hover:no-underline">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
        {orchestrators.length} orchestrators
      </summary>
      <div className="absolute right-0 top-[calc(100%+0.5rem)] z-10 min-w-[220px] overflow-hidden rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] shadow-[0_18px_40px_rgba(0,0,0,0.18)]">
        {orchestrators.map((orchestrator, index) => (
          <a
            key={orchestrator.id}
            href={`/sessions/${encodeURIComponent(orchestrator.id)}`}
            className={`flex items-center justify-between gap-3 px-4 py-3 text-[12px] hover:bg-[var(--color-bg-hover)] hover:no-underline ${
              index > 0 ? "border-t border-[var(--color-border-subtle)]" : ""
            }`}
          >
            <span className="flex min-w-0 items-center gap-2 text-[var(--color-text-primary)]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)] opacity-80" />
              <span className="truncate">{orchestrator.projectName}</span>
            </span>
            <svg
              className="h-3 w-3 shrink-0 opacity-60"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </a>
        ))}
      </div>
    </details>
  );
}

function StatusLine({ stats }: { stats: DashboardStats }) {
  if (stats.totalSessions === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">no sessions</span>;
  }

  const parts: Array<{ value: number; label: string; color?: string }> = [
    { value: stats.totalSessions, label: "sessions" },
    ...(stats.workingSessions > 0
      ? [{ value: stats.workingSessions, label: "working", color: "var(--color-status-working)" }]
      : []),
    ...(stats.openPRs > 0 ? [{ value: stats.openPRs, label: "PRs" }] : []),
    ...(stats.needsReview > 0
      ? [{ value: stats.needsReview, label: "need review", color: "var(--color-status-attention)" }]
      : []),
  ];

  return (
    <div className="flex items-baseline gap-0.5">
      {parts.map((part, index) => (
        <span key={part.label} className="flex items-baseline">
          {index > 0 && (
            <span className="mx-3 text-[11px] text-[var(--color-border-strong)]">·</span>
          )}
          <span
            className="text-[20px] font-bold tabular-nums tracking-tight"
            style={{ color: part.color ?? "var(--color-text-primary)" }}
          >
            {part.value}
          </span>
          <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{part.label}</span>
        </span>
      ))}
    </div>
  );
}
