"use client";

import type { Session } from "@aoagents/cloud-client";
import {
  AgentAvatar,
  boardAttentionZoneOrder,
  getAttentionZoneViewForZone,
  SessionCardView,
  SessionsBoardGridView,
  toSessionStatus,
  type BoardPullRequestPresentation,
} from "@aoagents/product-ui";
import { useEffect, useState, type ReactNode } from "react";

import { browserCloudClient } from "@/lib/cloud-client";
import { toBoardPullRequest } from "./pr-display";

const columns = boardAttentionZoneOrder.map((zone) =>
  getAttentionZoneViewForZone(zone),
);

const boardLabels = {
  columnAria: (label: string) => `${label} sessions`,
  countSessions: (count: number, label: string) =>
    `${count} ${label.toLowerCase()} sessions`,
  idleWorkingAria: "Idle and working sessions",
  laneSummary: (primary: string, secondary: string) =>
    `${primary} and ${secondary}`,
  readyMergedAria: "Ready and merged sessions",
  tones: {
    idle: {
      countLabel: "Idle",
      label: "Idle",
      regionLabel: "Idle sessions",
    },
    merged: {
      countLabel: "Merged",
      label: "Merged",
      regionLabel: "Merged sessions",
    },
    ready: {
      countLabel: "Ready",
      label: "Ready",
      regionLabel: "Ready sessions",
    },
    working: {
      countLabel: "Working",
      label: "Working",
      regionLabel: "Working sessions",
    },
  },
};

export function CloudBoard({
  onSelectSession,
  organizationId,
  sessions,
}: {
  onSelectSession: (sessionId: string) => void;
  organizationId: string;
  sessions: Session[];
}) {
  const [pullRequestsBySession, setPullRequestsBySession] = useState<
    Record<string, BoardPullRequestPresentation[]>
  >({});
  const sessionIds = sessions.map((session) => session.id).join(",");

  useEffect(() => {
    if (!sessionIds) return;
    let cancelled = false;
    const client = browserCloudClient();
    const loadPullRequests = async () => {
      const entries = await Promise.all(
        sessionIds.split(",").map(async (sessionId) => {
          try {
            const page = await client.listSessionPullRequests(
              organizationId,
              sessionId,
            );
            return [sessionId, page.pullRequests.map(toBoardPullRequest)] as const;
          } catch {
            return [sessionId, []] as const;
          }
        }),
      );
      if (!cancelled) setPullRequestsBySession(Object.fromEntries(entries));
    };
    void loadPullRequests();
    const interval = window.setInterval(() => void loadPullRequests(), 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [organizationId, sessionIds]);

  if (sessions.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium text-[var(--foreground)]">
            No sessions yet
          </p>
          <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">
            Workers and their activity will appear here when Cloud execution is
            available.
          </p>
        </div>
      </div>
    );
  }

  const presentation = sessions.map((session) => ({
    ...session,
    activity: {
      state: session.activityState,
      lastActivityAt: session.updatedAt,
    },
    provider: session.harness,
    status: toSessionStatus(session.status, session.isTerminated),
    title: session.displayName,
  }));

  return (
    <SessionsBoardGridView
      columns={columns}
      labels={boardLabels}
      sessions={presentation}
      renderSessionCard={(session) => (
        <SessionCardView
          externalLink={CloudExternalLink}
          labels={{
            formatTime: relativeTime,
            intakeIssue: (id) => `Issue ${id}`,
            pr: {
              short: "PR",
              states: {
                closed: "Closed",
                draft: "Draft",
                merged: "Merged",
                open: "Open",
              },
            },
            updatedAt: (timestamp) =>
              `Updated ${new Date(timestamp).toLocaleString()}`,
          }}
          onOpen={() => onSelectSession(session.id)}
          prs={pullRequestsBySession[session.id]}
          renderAvatar={(provider) => (
            <AgentAvatar
              className="mt-0.5"
              decorative
              logoSrc={`/agents/${provider}.svg`}
              provider={provider}
            />
          )}
          session={session}
        />
      )}
    />
  );
}

export function CloudExternalLink({
  ariaLabel,
  children,
  className,
  href,
  stopPropagation,
  title,
}: {
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  href: string;
  stopPropagation?: boolean;
  title?: string;
}) {
  return (
    <a
      aria-label={ariaLabel}
      className={className}
      href={href}
      onClick={stopPropagation ? (event) => event.stopPropagation() : undefined}
      rel="noreferrer"
      target="_blank"
      title={title}
    >
      {children}
    </a>
  );
}

function relativeTime(timestamp: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000),
  );
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
