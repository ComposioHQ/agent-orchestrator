"use client";

import { useMemo } from "react";
import type { ActivityEvent } from "@/lib/git-activity";

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

interface ActivityFeedProps {
  events: ActivityEvent[];
  sessions: SessionSnapshot[];
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

/** Format relative time */
function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const then = typeof date === "string" ? new Date(date) : date;
  const diffMs = now.getTime() - then.getTime();
  const diffSecs = Math.floor(diffMs / 1000);

  if (diffSecs < 5) return "just now";
  if (diffSecs < 60) return `${diffSecs}s ago`;

  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  return `${diffHours}h ago`;
}

/** Get icon for event type */
function getEventIcon(type: ActivityEvent["type"]): string {
  switch (type) {
    case "commit":
      return "M10 20a10 10 0 1 1 0-20 10 10 0 0 1 0 20zm-2-10a2 2 0 1 0 4 0 2 2 0 0 0-4 0z";
    case "push":
      return "M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z";
    case "file_change":
      return "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM8 12h8v2H8v-2zm0 4h8v2H8v-2z";
    case "pr_opened":
      return "M6 3a2 2 0 0 0-2 2v1.75a.75.75 0 0 0 1.5 0V5a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5v-1.75a.75.75 0 0 0-1.5 0V16a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H6zm7.78 4.22a.75.75 0 0 1 0 1.06l-1.97 1.97h6.44a.75.75 0 0 1 0 1.5h-6.44l1.97 1.97a.75.75 0 1 1-1.06 1.06l-3.25-3.25a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 0z";
    case "ci_status":
      return "M10 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-1-7.586l-2.293-2.293-1.414 1.414L9 13.414l5.707-5.707-1.414-1.414L9 10.586z";
    case "review":
      return "M8 16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2m-6 12h8a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z";
    default:
      return "M10 20a10 10 0 1 1 0-20 10 10 0 0 1 0 20z";
  }
}

export function ActivityFeed({ events, sessions }: ActivityFeedProps) {
  // Generate synthetic events from session state if no real events yet
  const displayEvents = useMemo(() => {
    if (events.length > 0) return events;

    // Create placeholder events from session states
    return sessions.map((session) => ({
      id: `synthetic-${session.id}`,
      type: "commit" as const,
      sessionId: session.id,
      branch: session.branch ?? "unknown",
      message: session.pr
        ? `PR #${session.pr.number} ${session.pr.state}`
        : `Working on ${session.branch ?? "branch"}`,
      timestamp: new Date(),
      data: {},
    }));
  }, [events, sessions]);

  if (displayEvents.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="mb-2 text-[var(--color-text-muted)]">
            <svg className="mx-auto h-12 w-12 opacity-50" fill="none" viewBox="0 0 24 24">
              <path
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <p className="text-sm text-[var(--color-text-muted)]">Waiting for activity...</p>
          <p className="text-xs text-[var(--color-text-muted)] opacity-60">
            Events will appear here as agents work
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 space-y-1 overflow-y-auto">
        {displayEvents.map((event) => (
          <ActivityEventRow key={event.id} event={event} />
        ))}
      </div>
    </div>
  );
}

function ActivityEventRow({ event }: { event: ActivityEvent }) {
  const color = getSessionColor(event.sessionId);

  return (
    <div className="group flex gap-3 rounded-md px-2 py-2 transition-colors hover:bg-[var(--color-bg-secondary)]">
      {/* Session indicator */}
      <div className="flex-shrink-0 pt-0.5">
        <div
          className="flex h-6 w-6 items-center justify-center rounded-full"
          style={{ backgroundColor: `${color}20` }}
        >
          <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20" style={{ color }}>
            <path d={getEventIcon(event.type)} />
          </svg>
        </div>
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold" style={{ color }}>
            {event.sessionId}
          </span>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {formatRelativeTime(event.timestamp)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-sm text-[var(--color-text-secondary)]">
          {event.message}
        </p>
        {event.data.files && event.data.files.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {event.data.files.slice(0, 3).map((file) => (
              <span
                key={file}
                className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]"
              >
                {file.split("/").pop()}
              </span>
            ))}
            {event.data.files.length > 3 && (
              <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                +{event.data.files.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
