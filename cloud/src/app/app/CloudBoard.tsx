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
import { Pin, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { browserCloudClient } from "@/lib/cloud-client";
import { toBoardPullRequest } from "./pr-display";
import { harnessLogoSource } from "./harness-logo";

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
  onDeleteSession = () => {},
  onPinSession = () => {},
  onSelectSession,
  organizationId,
  sessions,
}: {
  onDeleteSession?: (session: Session) => void;
  onPinSession?: (session: Session) => void;
  onSelectSession: (sessionId: string) => void;
  organizationId: string;
  sessions: Session[];
}) {
  const workerSessions = sessions.filter(
    (session) => session.kind !== "orchestrator",
  );
  const [pullRequestsBySession, setPullRequestsBySession] = useState<
    Record<string, BoardPullRequestPresentation[]>
  >({});
  const sessionIds = workerSessions.map((session) => session.id).join(",");

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

  if (workerSessions.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto">
        <div className="flex w-full max-w-[400px] flex-col items-center pb-[5vh] text-center">
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--foreground)]">
            No sessions yet
          </h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
            Sessions and their activity will appear here once work begins on this project.
          </p>
        </div>
      </div>
    );
  }

  const presentation = workerSessions.map((session) => ({
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
      renderSessionCard={(session) => {
        const original = workerSessions.find((s) => s.id === session.id);
        return (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div>
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
                      logoSrc={harnessLogoSource(provider)}
                      provider={provider}
                    />
                  )}
                  session={session}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-40">
              <ContextMenuItem onSelect={() => onSelectSession(session.id)}>
                Open session
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => original && onPinSession(original)}>
                <Pin aria-hidden="true" />
                Pin
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className="text-[var(--destructive)] focus:text-[var(--destructive)] [&_svg]:text-[var(--destructive)]"
                onSelect={() => {
                  if (original && window.confirm(`Delete ${session.title}?`)) onDeleteSession(original);
                }}
              >
                <Trash2 aria-hidden="true" />
                Delete session
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      }}
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
