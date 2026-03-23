"use client";

import { memo } from "react";
import type { DashboardSession, AttentionLevel } from "@/lib/types";
import { SessionCard } from "./SessionCard";

interface AttentionZoneProps {
  level: AttentionLevel;
  sessions: DashboardSession[];
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

const zoneConfig: Record<
  AttentionLevel,
  {
    label: string;
    color: string;
    caption: string;
  }
> = {
  merge: {
    label: "Ready",
    color: "var(--color-status-ready)",
    caption: "Cleared to land",
  },
  respond: {
    label: "Respond",
    color: "var(--color-status-error)",
    caption: "Human judgment needed",
  },
  review: {
    label: "Review",
    color: "var(--color-accent-orange)",
    caption: "Code waiting on eyes",
  },
  pending: {
    label: "Pending",
    color: "var(--color-status-attention)",
    caption: "Blocked on system state",
  },
  working: {
    label: "Working",
    color: "var(--color-status-working)",
    caption: "Agents are actively moving",
  },
  done: {
    label: "Done",
    color: "var(--color-text-tertiary)",
    caption: "Completed or exited",
  },
};

/**
 * Kanban column — always renders (even when empty) to preserve
 * the board shape. Cards scroll independently within each column.
 */
function AttentionZoneView({
  level,
  sessions,
  onSend,
  onKill,
  onMerge,
  onRestore,
}: AttentionZoneProps) {
  const config = zoneConfig[level];

  return (
    <div className="kanban-column" data-level={level}>
      <div className="kanban-column__header">
        <div className="kanban-column__title-row">
          <div className="kanban-column__dot" style={{ background: config.color }} />
          <span className="kanban-column__title">{config.label}</span>
          <span className="kanban-column__count">{sessions.length}</span>
        </div>
        <p className="kanban-column__caption">{config.caption}</p>
      </div>

      <div className="kanban-column-body">
        {sessions.length > 0 ? (
          <div className="flex flex-col gap-2">
            {sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                onSend={onSend}
                onKill={onKill}
                onMerge={onMerge}
                onRestore={onRestore}
              />
            ))}
          </div>
        ) : (
          <div className="kanban-column__empty">
            <span className="kanban-column__empty-label">No sessions</span>
          </div>
        )}
      </div>
    </div>
  );
}

function areAttentionZonePropsEqual(prev: AttentionZoneProps, next: AttentionZoneProps): boolean {
  return (
    prev.level === next.level &&
    prev.onSend === next.onSend &&
    prev.onKill === next.onKill &&
    prev.onMerge === next.onMerge &&
    prev.onRestore === next.onRestore &&
    prev.sessions.length === next.sessions.length &&
    prev.sessions.every((session, index) => session === next.sessions[index])
  );
}

export const AttentionZone = memo(AttentionZoneView, areAttentionZonePropsEqual);
