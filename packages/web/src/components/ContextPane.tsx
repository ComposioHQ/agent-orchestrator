"use client";

import type { PortfolioActionItem } from "@/lib/types";

interface ContextPaneProps {
  item: PortfolioActionItem;
}

export function ContextPane({ item }: ContextPaneProps) {
  const { session, projectName } = item;

  return (
    <div className="w-[360px] shrink-0 overflow-y-auto bg-[var(--color-bg-elevated)] p-4">
      <div className="mb-4">
        <h3 className="text-[15px] font-medium text-[var(--color-text-primary)]">{session.id}</h3>
        <p className="text-[12px] text-[var(--color-text-tertiary)]">{projectName}</p>
      </div>

      <dl className="space-y-3 text-[13px]">
        <div>
          <dt className="text-[11px] font-medium uppercase text-[var(--color-text-tertiary)]">Status</dt>
          <dd className="text-[var(--color-text-secondary)]">{session.status}</dd>
        </div>

        {session.branch && (
          <div>
            <dt className="text-[11px] font-medium uppercase text-[var(--color-text-tertiary)]">Branch</dt>
            <dd className="text-[var(--color-text-secondary)]">{session.branch}</dd>
          </div>
        )}

        {session.summary && (
          <div>
            <dt className="text-[11px] font-medium uppercase text-[var(--color-text-tertiary)]">Summary</dt>
            <dd className="text-[var(--color-text-secondary)]">{session.summary}</dd>
          </div>
        )}

        {session.pr && (
          <div>
            <dt className="text-[11px] font-medium uppercase text-[var(--color-text-tertiary)]">Pull Request</dt>
            <dd>
              <a
                href={session.pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-accent)] hover:underline"
              >
                #{session.pr.number} {session.pr.title}
              </a>
            </dd>
          </div>
        )}

        {session.issueUrl && (
          <div>
            <dt className="text-[11px] font-medium uppercase text-[var(--color-text-tertiary)]">Issue</dt>
            <dd>
              <a
                href={session.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-accent)] hover:underline"
              >
                {session.issueLabel || session.issueId || "View issue"}
              </a>
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-6 flex gap-2">
        <a
          href={`/projects/${encodeURIComponent(item.projectId)}/sessions/${encodeURIComponent(session.id)}`}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
        >
          Open session
        </a>
        <a
          href={`/projects/${encodeURIComponent(item.projectId)}`}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-base)]"
        >
          View project
        </a>
      </div>
    </div>
  );
}
