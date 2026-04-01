"use client";

import { memo, useEffect, useState } from "react";
import {
  type DashboardSession,
  type AttentionLevel,
  isPRMergeReady,
} from "@/lib/types";
import { getProjectSessionHref } from "@/lib/project-utils";
import { SessionCard } from "./SessionCard";
import { getSessionTitle } from "@/lib/format";

interface AttentionZoneProps {
  level: AttentionLevel;
  sessions: DashboardSession[];
  onSend?: (sessionId: string, message: string) => Promise<void> | void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
  /** Accordion mode: whether this section is collapsed (mobile only) */
  collapsed?: boolean;
  /** Accordion mode: called when the header is tapped to toggle */
  onToggle?: (level: AttentionLevel) => void;
  /** Dense mobile rows rendered instead of full cards */
  compactMobile?: boolean;
  /** Open the lightweight mobile preview sheet */
  onPreview?: (session: DashboardSession) => void;
  /** Reset internal "show all" state when this value changes */
  resetKey?: string | number | null;
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
 *
 * When `collapsed` and `onToggle` are provided the component renders
 * in accordion mode (mobile): a 44 px tappable header only, with the
 * card list hidden. Empty sections in accordion mode omit the dashed
 * placeholder entirely — just the single-line header is shown.
 */
function AttentionZoneView({
  level,
  sessions,
  onSend,
  onKill,
  onMerge,
  onRestore,
  collapsed,
  onToggle,
  compactMobile,
  onPreview,
  resetKey,
}: AttentionZoneProps) {
  const config = zoneConfig[level];
  const isAccordion = onToggle !== undefined;
  const [showAll, setShowAll] = useState(false);
  const visibleSessions =
    isAccordion && compactMobile && !showAll ? sessions.slice(0, 5) : sessions;
  const hiddenCount = sessions.length - visibleSessions.length;

  useEffect(() => {
    if (collapsed) {
      setShowAll(false);
    }
  }, [collapsed]);

  useEffect(() => {
    setShowAll(false);
  }, [resetKey]);

  if (isAccordion) {
    return (
      <div
        className={`accordion-section${collapsed ? " accordion-section--collapsed" : " accordion-section--expanded"}`}
        data-level={level}
      >
        <button
          type="button"
          className="accordion-header"
          onClick={() => onToggle(level)}
          aria-expanded={!collapsed}
        >
          <span className="accordion-header__dot" style={{ background: config.color }} />
          <span className="accordion-header__label">{config.label}</span>
          <span className="accordion-header__count">{sessions.length}</span>
          <span className="accordion-header__chevron" aria-hidden="true">▶</span>
        </button>

        <div className="accordion-body">
          {sessions.length > 0 ? (
            <div className={compactMobile ? "mobile-session-list" : "flex flex-col gap-2 p-3"}>
              {visibleSessions.map((session) =>
                compactMobile ? (
                  <MobileSessionRow
                    key={session.id}
                    session={session}
                    level={level}
                    onPreview={onPreview}
                  />
                ) : (
                  <SessionCard
                    key={session.id}
                    session={session}
                    onSend={onSend}
                    onKill={onKill}
                    onMerge={onMerge}
                    onRestore={onRestore}
                  />
                ),
              )}
              {compactMobile && hiddenCount > 0 ? (
                <button
                  type="button"
                  className="mobile-session-list__view-all"
                  onClick={() => setShowAll(true)}
                >
                  View all {sessions.length}
                </button>
              ) : null}
            </div>
          ) : compactMobile ? (
            <div className="mobile-session-list">
              <div className="mobile-session-list__empty">No sessions</div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

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
    prev.collapsed === next.collapsed &&
    prev.onToggle === next.onToggle &&
    prev.onSend === next.onSend &&
    prev.onKill === next.onKill &&
    prev.onMerge === next.onMerge &&
    prev.onRestore === next.onRestore &&
    prev.compactMobile === next.compactMobile &&
    prev.onPreview === next.onPreview &&
    prev.resetKey === next.resetKey &&
    prev.sessions.length === next.sessions.length &&
    prev.sessions.every((session, index) => session === next.sessions[index])
  );
}

export const AttentionZone = memo(AttentionZoneView, areAttentionZonePropsEqual);

function MobileSessionRow({
  session,
  level,
  onPreview,
}: {
  session: DashboardSession;
  level: AttentionLevel;
  onPreview?: (session: DashboardSession) => void;
}) {
  const meta = [
    session.branch,
    session.pr ? `PR #${session.pr.number}` : null,
    session.issueLabel,
  ].filter(Boolean);

  return (
    <div className="mobile-session-row">
      <button
        type="button"
        className="mobile-session-row__preview"
        onClick={() => onPreview?.(session)}
        aria-label={`Open ${getSessionTitle(session)}`}
      >
        <div className="mobile-session-row__line">
          <span
            className="mobile-session-row__dot"
            style={{ background: zoneConfig[level].color }}
            aria-hidden="true"
          />
          <span className="mobile-session-row__title">{getSessionTitle(session)}</span>
        </div>
        <div className="mobile-session-row__meta">
          {meta.length > 0 ? meta.join(" · ") : "No branch or PR metadata"}
        </div>
      </button>
      <div className="mobile-session-row__side">
        <SessionStateChip session={session} level={level} />
        <a
          href={getProjectSessionHref(session.projectId, session.id)}
          className="mobile-session-row__open"
          aria-label={`Go to ${getSessionTitle(session)}`}
        >
          <svg
            className="mobile-session-row__open-icon"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M4 17V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
            <path d="m8 10 2 2-2 2M12 14h4" />
          </svg>
        </a>
      </div>
    </div>
  );
}

function SessionStateChip({
  session,
  level,
}: {
  session: DashboardSession;
  level: AttentionLevel;
}) {
  let label = zoneConfig[level].label.toLowerCase();

  if (level === "merge" && session.pr && isPRMergeReady(session.pr)) {
    label = "ready";
  } else if (level === "respond") {
    label = session.activity === "waiting_input" ? "waiting" : "needs input";
  } else if (level === "review") {
    label = session.pr?.reviewDecision === "changes_requested" ? "changes" : "review";
  } else if (level === "pending") {
    label = session.pr?.unresolvedThreads ? "threads" : "pending";
  } else if (level === "working") {
    label = session.activity === "idle" ? "idle" : "active";
  }

  return <span className="mobile-session-row__chip">{label}</span>;
}
