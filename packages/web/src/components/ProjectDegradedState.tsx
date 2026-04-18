"use client";

interface ProjectDegradedStateProps {
  projectId: string;
  projectName: string;
  reason?: string;
  compact?: boolean;
}

export function ProjectDegradedState({
  projectId,
  projectName,
  reason,
  compact = false,
}: ProjectDegradedStateProps) {
  return (
    <div className={compact ? "px-5 py-8 sm:px-6 lg:px-10" : "min-h-screen px-5 py-8 sm:px-6 lg:px-10"}>
      <div className="mx-auto max-w-[920px]">
        <section className="rounded-[2px] border border-[color-mix(in_srgb,var(--color-status-error)_22%,transparent)] bg-[var(--color-bg-surface)] px-6 py-6 shadow-[var(--card-shadow)]">
          <div className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.18em] text-[var(--color-status-error)]">
            Degraded Project
          </div>
          <h1 className="mt-3 text-[var(--font-size-xl)] font-bold tracking-[-0.025em] text-[var(--color-text-primary)]">
            {projectName} needs config attention
          </h1>
          <p className="mt-3 max-w-[62ch] text-[var(--font-size-base)] leading-relaxed text-[var(--color-text-secondary)]">
            Agent Orchestrator can still list this project in the portfolio, but project-scoped actions are paused until its local config resolves cleanly.
          </p>
          {reason ? (
            <div className="mt-5 rounded-[2px] border border-[color-mix(in_srgb,var(--color-status-error)_22%,transparent)] bg-[var(--color-tint-red)] px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-status-error)]">
                Resolver output
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-primary)]">{reason}</p>
            </div>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={`/settings#projects`}
              className="border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)] hover:no-underline"
            >
              Open project settings
            </a>
            <a
              href={`/projects/${encodeURIComponent(projectId)}`}
              className="border border-[var(--color-border-default)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)] hover:no-underline"
            >
              Refresh project page
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
