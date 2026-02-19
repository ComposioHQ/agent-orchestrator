"use client";

import { useMemo } from "react";
import type { SessionGitActivity } from "@/lib/git-activity";

interface SessionSnapshot {
  id: string;
  branch: string | null;
  status: string;
  activity: string;
  pr: {
    number: number;
    state: string;
    ciStatus: string;
  } | null;
}

interface BranchTimelineProps {
  sessions: SessionSnapshot[];
  gitActivity: Record<string, SessionGitActivity>;
}

/** Get a color for a session based on its ID (consistent hashing) */
function getSessionColor(sessionId: string): string {
  const colors = [
    "#58a6ff", // blue
    "#3fb950", // green
    "#a371f7", // purple
    "#f0883e", // orange
    "#f778ba", // pink
    "#79c0ff", // light blue
    "#7ee787", // light green
    "#d2a8ff", // light purple
  ];
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash << 5) - hash + sessionId.charCodeAt(i);
    hash = hash & hash;
  }
  return colors[Math.abs(hash) % colors.length];
}

/** Get status indicator color */
function getStatusColor(status: string): string {
  switch (status) {
    case "working":
    case "spawning":
      return "var(--color-accent-green)";
    case "pr_open":
    case "review_pending":
      return "var(--color-accent-blue)";
    case "ci_failed":
    case "changes_requested":
      return "var(--color-accent-red)";
    case "approved":
    case "mergeable":
      return "var(--color-accent-purple)";
    case "merged":
    case "done":
      return "var(--color-text-muted)";
    default:
      return "var(--color-accent-yellow)";
  }
}

/** Get CI status indicator */
function getCIIndicator(ciStatus: string | undefined): { color: string; label: string } {
  switch (ciStatus) {
    case "passing":
      return { color: "var(--color-accent-green)", label: "CI passing" };
    case "failing":
      return { color: "var(--color-accent-red)", label: "CI failing" };
    case "pending":
      return { color: "var(--color-accent-yellow)", label: "CI running" };
    default:
      return { color: "var(--color-text-muted)", label: "No CI" };
  }
}

export function BranchTimeline({ sessions, gitActivity }: BranchTimelineProps) {
  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      // Active sessions first
      const aActive = a.activity === "active";
      const bActive = b.activity === "active";
      if (aActive !== bActive) return bActive ? 1 : -1;

      // Then by commits ahead
      const aCommits = gitActivity[a.id]?.commitsAhead ?? 0;
      const bCommits = gitActivity[b.id]?.commitsAhead ?? 0;
      return bCommits - aCommits;
    });
  }, [sessions, gitActivity]);

  if (sortedSessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-2 text-[var(--color-text-muted)]">
            <svg className="mx-auto h-12 w-12 opacity-50" fill="none" viewBox="0 0 24 24">
              <path
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M3 7h18M3 12h18M3 17h18"
              />
            </svg>
          </div>
          <p className="text-sm text-[var(--color-text-muted)]">No active branches</p>
          <p className="text-xs text-[var(--color-text-muted)] opacity-60">
            Spawn agents to see branch activity
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* Main branch reference line */}
      <div className="mb-4 flex items-center gap-3">
        <div className="w-[100px] flex-shrink-0 text-right">
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">main</span>
        </div>
        <div className="relative h-[2px] flex-1 bg-[var(--color-border-emphasis)]">
          <div className="absolute left-0 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-[var(--color-border-emphasis)] bg-[var(--color-bg-primary)]" />
          <div className="absolute right-0 top-1/2 -translate-y-1/2">
            <svg
              className="h-3 w-3 text-[var(--color-border-emphasis)]"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path d="M10 3l7 7-7 7V3z" />
            </svg>
          </div>
        </div>
      </div>

      {/* Branch swimlanes */}
      {sortedSessions.map((session) => (
        <BranchLane key={session.id} session={session} activity={gitActivity[session.id]} />
      ))}
    </div>
  );
}

function BranchLane({
  session,
  activity,
}: {
  session: SessionSnapshot;
  activity: SessionGitActivity | undefined;
}) {
  const color = getSessionColor(session.id);
  const statusColor = getStatusColor(session.status);
  const commits = activity?.commits ?? [];
  const commitsAhead = activity?.commitsAhead ?? 0;
  const ci = session.pr ? getCIIndicator(session.pr.ciStatus) : null;

  return (
    <div className="group flex items-center gap-3 rounded-md py-2 transition-colors hover:bg-[var(--color-bg-secondary)]">
      {/* Session label */}
      <div className="w-[100px] flex-shrink-0 text-right">
        <div className="flex items-center justify-end gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: statusColor }}
            title={session.status}
          />
          <span className="text-xs font-medium" style={{ color }}>
            {session.id}
          </span>
        </div>
        {session.branch && (
          <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">
            {session.branch}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="relative flex h-8 flex-1 items-center">
        {/* Branch line */}
        <div
          className="absolute left-0 right-0 h-[2px]"
          style={{ backgroundColor: `${color}40` }}
        />

        {/* Diverge point from main */}
        <div
          className="absolute left-0 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2"
          style={{ borderColor: color, backgroundColor: "var(--color-bg-primary)" }}
        />

        {/* Commits as nodes */}
        <div className="absolute left-4 right-4 flex items-center justify-between">
          {commits.length > 0 ? (
            <>
              {commits.slice(0, 8).map((commit, idx) => (
                <div
                  key={commit.hash}
                  className="group/commit relative"
                  style={{
                    left: `${(idx / Math.max(commits.length - 1, 1)) * 100}%`,
                  }}
                >
                  <div
                    className="h-2.5 w-2.5 rounded-full transition-transform group-hover/commit:scale-150"
                    style={{ backgroundColor: color }}
                    title={commit.message}
                  />
                  {/* Tooltip */}
                  <div className="absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs group-hover/commit:block">
                    <div className="font-mono text-[var(--color-text-muted)]">
                      {commit.shortHash}
                    </div>
                    <div className="max-w-[200px] truncate text-[var(--color-text-secondary)]">
                      {commit.message}
                    </div>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <span className="text-[10px] italic text-[var(--color-text-muted)]">
              No recent commits
            </span>
          )}
        </div>

        {/* PR indicator if exists */}
        {session.pr && (
          <div
            className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-full border px-2 py-0.5"
            style={{
              borderColor: color,
              backgroundColor: `${color}20`,
            }}
          >
            <span className="text-[10px] font-medium" style={{ color }}>
              PR #{session.pr.number}
            </span>
            {ci && (
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: ci.color }}
                title={ci.label}
              />
            )}
          </div>
        )}
      </div>

      {/* Commits ahead badge */}
      <div className="w-[60px] flex-shrink-0 text-right">
        {commitsAhead > 0 && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor: `${color}20`,
              color,
            }}
          >
            +{commitsAhead}
          </span>
        )}
      </div>
    </div>
  );
}
