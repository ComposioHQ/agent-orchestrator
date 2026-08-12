"use client";

import type { Session } from "@aoagents/cloud-client";
import {
  AgentAvatar,
  boardAttentionZoneOrder,
  getAttentionZoneViewForZone,
  SessionCardView,
  SessionsBoardGridView,
  toSessionStatus,
} from "@aoagents/product-ui";
import type { ReactNode } from "react";

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
  sessions,
}: {
  onSelectSession: (sessionId: string) => void;
  sessions: Session[];
}) {
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

function CloudExternalLink({
  children,
  className,
  href,
  stopPropagation,
}: {
  children: ReactNode;
  className?: string;
  href: string;
  stopPropagation?: boolean;
}) {
  return (
    <a
      className={className}
      href={href}
      onClick={stopPropagation ? (event) => event.stopPropagation() : undefined}
      rel="noreferrer"
      target="_blank"
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
