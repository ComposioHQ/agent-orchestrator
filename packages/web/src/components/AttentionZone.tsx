"use client";

import { memo } from "react";
import type { DashboardSession, AttentionLevel } from "@/lib/types";
import { SessionCard } from "./SessionCard";

interface AttentionZoneProps {
  level: AttentionLevel;
  sessions: DashboardSession[];
  variant?: "board" | "list";
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
  }
> = {
  merge: {
    label: "Merge Ready",
    color: "var(--color-status-ready)",
  },
  respond: {
    label: "Respond",
    color: "var(--color-status-error)",
  },
  review: {
    label: "Review",
    color: "var(--color-accent-orange)",
  },
  pending: {
    label: "Pending",
    color: "var(--color-status-attention)",
  },
  working: {
    label: "Working",
    color: "var(--color-status-working)",
  },
  done: {
    label: "Done",
    color: "var(--color-text-tertiary)",
  },
};

/**
 * Kanban column — always renders (even when empty) to preserve
 * the board shape. Cards scroll independently within each column.
 */
function AttentionZoneView({
  level,
  sessions,
  variant = "board",
  onSend,
  onKill,
  onMerge,
  onRestore,
}: AttentionZoneProps) {
  const config = zoneConfig[level];

  return (
    <div className={variant === "board" ? "kanban-column" : "w-full"}>
      {/* Column header */}
      <div className="mb-2 flex items-center gap-2 px-1 py-1.5">
        <div
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: config.color }}
        />
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-secondary)]">
          {config.label}
        </span>
        <span className="rounded-full bg-[var(--color-bg-subtle)] px-1.5 py-0 text-[11px] font-medium tabular-nums text-[var(--color-text-muted)]">
          {sessions.length}
        </span>
      </div>

      {/* Column body — scrollable */}
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
          <div className="flex h-20 items-center justify-center rounded-[6px] border border-dashed border-[var(--color-border-subtle)]">
            <span className="text-[11px] text-[var(--color-text-muted)]">
              No sessions
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function areAttentionZonePropsEqual(
  prev: AttentionZoneProps,
  next: AttentionZoneProps,
): boolean {
  return (
    prev.level === next.level &&
    prev.variant === next.variant &&
    prev.onSend === next.onSend &&
    prev.onKill === next.onKill &&
    prev.onMerge === next.onMerge &&
    prev.onRestore === next.onRestore &&
    prev.sessions.length === next.sessions.length &&
    prev.sessions.every((session, index) => session === next.sessions[index])
  );
}

export const AttentionZone = memo(AttentionZoneView, areAttentionZonePropsEqual);
