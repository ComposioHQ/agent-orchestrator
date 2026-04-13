"use client";

import { memo } from "react";
import type { DashboardSession, SessionStatus } from "@/lib/types";
import { SessionCard } from "./SessionCard";
import { PHASE_LABELS, getPhaseStatusColor, type PhaseLaneId } from "@/lib/phases";

interface PhaseLaneProps {
  laneId: PhaseLaneId;
  label: string;
  description: string;
  statuses: readonly SessionStatus[];
  sessionsByStatus: Partial<Record<SessionStatus, DashboardSession[]>>;
  expanded: boolean;
  onSend?: (sessionId: string, message: string) => Promise<void> | void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

function PhaseLaneView({
  laneId,
  label,
  description,
  statuses,
  sessionsByStatus,
  expanded,
  onSend,
  onKill,
  onMerge,
  onRestore,
}: PhaseLaneProps) {
  const allSessions = statuses.flatMap((status) => sessionsByStatus[status] ?? []);
  const total = allSessions.length;

  if (!expanded) {
    return (
      <div className="kanban-column phase-lane phase-lane--collapsed" data-lane={laneId}>
        <div className="kanban-column__header">
          <div className="kanban-column__title-row">
            <div
              className="kanban-column__dot"
              style={{ backgroundColor: getPhaseStatusColor(statuses[0] ?? "working") }}
            />
            <span className="kanban-column__title">{label}</span>
            <span className="kanban-column__count">{total}</span>
          </div>
          <p className="phase-lane__description">{description}</p>
        </div>

        <div className="kanban-column-body">
          {total > 0 ? (
            <div className="kanban-column__stack">
              {allSessions.map((session) => (
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
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="phase-lane phase-lane--expanded" data-lane={laneId}>
      <div className="phase-lane__header">
        <span className="phase-lane__label">{label}</span>
        <span className="phase-lane__count">{total}</span>
        <p className="phase-lane__description">{description}</p>
      </div>
      <div className="phase-lane__sub">
        {statuses.map((status) => {
          const sessions = sessionsByStatus[status] ?? [];
          return (
            <div
              key={status}
              className="kanban-column phase-lane__sub-column"
              data-status={status}
            >
              <div className="kanban-column__header">
                <div className="kanban-column__title-row">
                  <div
                    className="kanban-column__dot"
                    style={{ backgroundColor: getPhaseStatusColor(status) }}
                  />
                  <span className="kanban-column__title">{PHASE_LABELS[status]}</span>
                  <span className="kanban-column__count">{sessions.length}</span>
                </div>
              </div>
              <div className="kanban-column-body">
                {sessions.length > 0 ? (
                  <div className="kanban-column__stack">
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
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function arePhaseLanePropsEqual(prev: PhaseLaneProps, next: PhaseLaneProps): boolean {
  if (
    prev.laneId !== next.laneId ||
    prev.label !== next.label ||
    prev.description !== next.description ||
    prev.expanded !== next.expanded ||
    prev.onSend !== next.onSend ||
    prev.onKill !== next.onKill ||
    prev.onMerge !== next.onMerge ||
    prev.onRestore !== next.onRestore ||
    prev.statuses !== next.statuses
  ) {
    return false;
  }
  for (const status of prev.statuses) {
    const a = prev.sessionsByStatus[status] ?? [];
    const b = next.sessionsByStatus[status] ?? [];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
  }
  return true;
}

export const PhaseLane = memo(PhaseLaneView, arePhaseLanePropsEqual);
