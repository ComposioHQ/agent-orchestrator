"use client";

import { useState, useEffect } from "react";
import type { DashboardSession } from "@/lib/types";
import { ActivityDisplay } from "./ActivityDisplay";
import {
  activityMeta,
  humanizeStatus,
  relativeTime,
  buildGitHubBranchUrl,
  buildGitHubRepoUrl,
} from "./session-detail-helpers";

interface SessionHeaderProps {
  session: DashboardSession;
  isOrchestrator?: boolean;
}

export function SessionHeader({ session, isOrchestrator = false }: SessionHeaderProps) {
  const pr = session.pr;
  const activity = (session.activity && activityMeta[session.activity]) ?? {
    label: session.activity ?? "unknown",
    color: "var(--color-text-muted)",
  };
  const accentColor = "var(--color-accent)";

  return (
    <div
      className="detail-card mb-6 rounded-[var(--radius-lg)] border border-[var(--color-border-default)] p-4 md:p-5"
      style={{
        borderLeft: isOrchestrator ? `3px solid ${accentColor}` : `3px solid ${activity.color}`,
      }}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="break-all font-[var(--font-mono)] text-[14px] font-semibold tracking-[-0.01em] text-[var(--color-text-primary)] md:text-[17px]">
              {session.id}
            </h1>
            <ActivityDisplay
              activity={session.activity}
              label={activity.label}
              color={activity.color}
            />
          </div>

          {session.summary && (
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
              {session.summary}
            </p>
          )}

          {/* Meta chips */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 [&_a]:min-h-[44px] [&_a]:inline-flex [&_a]:items-center md:[&_a]:min-h-0">
            {session.projectId && (
              <>
                {pr ? (
                  <a
                    href={buildGitHubRepoUrl(pr)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] hover:no-underline"
                  >
                    {session.projectId}
                  </a>
                ) : (
                  <span className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                    {session.projectId}
                  </span>
                )}
                <span className="text-[var(--color-text-tertiary)]">&middot;</span>
              </>
            )}

            {pr && (
              <>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[11px] text-[var(--color-accent)] transition-colors hover:border-[var(--color-accent)] hover:no-underline"
                >
                  PR #{pr.number}
                </a>
                {(session.branch || session.issueUrl) && (
                  <span className="text-[var(--color-text-tertiary)]">&middot;</span>
                )}
              </>
            )}

            {session.branch && (
              <>
                {pr ? (
                  <a
                    href={buildGitHubBranchUrl(pr)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] hover:no-underline"
                  >
                    {session.branch}
                  </a>
                ) : (
                  <span className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-text-secondary)]">
                    {session.branch}
                  </span>
                )}
                {session.issueUrl && (
                  <span className="text-[var(--color-text-tertiary)]">&middot;</span>
                )}
              </>
            )}

            {session.issueUrl && (
              <a
                href={session.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] hover:no-underline"
              >
                {session.issueLabel || session.issueUrl}
              </a>
            )}
          </div>

          <ClientTimestamps
            status={session.status}
            createdAt={session.createdAt}
            lastActivityAt={session.lastActivityAt}
          />
        </div>
      </div>
    </div>
  );
}

// ── Client-side timestamps ────────────────────────────────────────────

function ClientTimestamps({
  status,
  createdAt,
  lastActivityAt,
}: {
  status: string;
  createdAt: string;
  lastActivityAt: string;
}) {
  const [created, setCreated] = useState<string | null>(null);
  const [lastActive, setLastActive] = useState<string | null>(null);

  useEffect(() => {
    setCreated(relativeTime(createdAt));
    setLastActive(relativeTime(lastActivityAt));
  }, [createdAt, lastActivityAt]);

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--color-text-tertiary)]">
      <span className="rounded-[var(--radius-sm)] bg-[rgba(255,255,255,0.05)] px-1.5 py-0.5 text-[10px] font-medium">
        {humanizeStatus(status)}
      </span>
      {created && (
        <>
          <span className="opacity-40">&middot;</span>
          <span>created {created}</span>
        </>
      )}
      {lastActive && (
        <>
          <span className="opacity-40">&middot;</span>
          <span>active {lastActive}</span>
        </>
      )}
    </div>
  );
}
