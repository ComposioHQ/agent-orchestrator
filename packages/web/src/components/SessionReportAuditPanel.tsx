"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import type { DashboardAgentReportAuditEntry } from "@/lib/types";

const RECENT_AUDIT_LIMIT = 10;

function formatAuditTimestamp(isoDate: string): string {
  const parsed = Date.parse(isoDate);
  if (Number.isNaN(parsed)) return isoDate;
  return new Date(parsed).toLocaleString();
}

function getAuditCommandLabel(entry: DashboardAgentReportAuditEntry): string {
  return entry.source === "acknowledge" ? "ao acknowledge" : `ao report ${entry.reportState}`;
}

export function SessionReportAuditPanel({
  sessionId,
  entries,
}: {
  sessionId: string;
  entries: DashboardAgentReportAuditEntry[];
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showOlderEntries, setShowOlderEntries] = useState(false);
  const panelId = `${sessionId}-report-audit-panel`;
  const hasOlderEntries = entries.length > RECENT_AUDIT_LIMIT;
  const visibleEntries =
    showOlderEntries || !hasOlderEntries ? entries : entries.slice(0, RECENT_AUDIT_LIMIT);

  if (entries.length === 0) {
    return null;
  }

  return (
    <section className="mb-4 rounded-[20px] border border-[var(--color-border-muted)] bg-[var(--color-bg-panel)] px-4 py-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={isExpanded}
        aria-controls={panelId}
        onClick={() => setIsExpanded((current) => !current)}
      >
        <span className="block">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
            Agent Reports
          </span>
          <span className="mt-1 block text-[12px] text-[var(--color-text-secondary)]">
            {entries.length} audit {entries.length === 1 ? "entry" : "entries"}
          </span>
        </span>
        <span
          className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--color-border-muted)] bg-[var(--color-bg-base)] text-[var(--color-text-secondary)]"
          aria-hidden="true"
        >
          <svg
            className={cn(
              "h-4 w-4 transition-transform duration-200",
              isExpanded ? "rotate-180" : "rotate-0",
            )}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      <div id={panelId} hidden={!isExpanded} className="mt-3 space-y-3">
        {visibleEntries.map((entry, index) => (
          <div
            key={`${entry.timestamp}-${entry.reportState}-${entry.actor}-${entry.source}-${String(entry.accepted)}-${index}`}
            className="rounded-[16px] border border-[var(--color-border-muted)] bg-[var(--color-bg-base)] px-3 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  entry.accepted
                    ? "border-[var(--color-status-ready)]/25 bg-[var(--color-tint-green)] text-[var(--color-status-ready)]"
                    : "border-[var(--color-status-error)]/25 bg-[var(--color-tint-red)] text-[var(--color-status-error)]",
                )}
              >
                {entry.accepted ? "Accepted" : "Rejected"}
              </span>
              <span className="text-[11px] text-[var(--color-text-tertiary)]">
                {formatAuditTimestamp(entry.timestamp)}
              </span>
            </div>
            <div className="mt-3 grid gap-2 text-[12px] text-[var(--color-text-secondary)] sm:grid-cols-3">
              <div className="rounded-[12px] border border-[var(--color-border-muted)] px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                  Session
                </div>
                <div className="mt-1 font-[var(--font-mono)] text-[var(--color-text-primary)]">
                  {sessionId}
                </div>
              </div>
              <div className="rounded-[12px] border border-[var(--color-border-muted)] px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                  Actor
                </div>
                <div className="mt-1 text-[var(--color-text-primary)]">{entry.actor}</div>
              </div>
              <div className="rounded-[12px] border border-[var(--color-border-muted)] px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                  Source
                </div>
                <div className="mt-1 font-[var(--font-mono)] text-[var(--color-text-primary)]">
                  {getAuditCommandLabel(entry)}
                </div>
              </div>
            </div>
            <div className="mt-3 text-[12px] text-[var(--color-text-secondary)]">
              {entry.before.legacyStatus} / {entry.before.sessionState}
              {" -> "}
              {entry.after.legacyStatus} / {entry.after.sessionState}
            </div>
            {entry.note ? (
              <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">
                Note: {entry.note}
              </p>
            ) : null}
            {entry.rejectionReason ? (
              <p className="mt-2 text-[12px] text-[var(--color-status-error)]">
                Rejection: {entry.rejectionReason}
              </p>
            ) : null}
          </div>
        ))}
        {hasOlderEntries && !showOlderEntries ? (
          <button
            type="button"
            className="text-[12px] font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)]"
            onClick={() => setShowOlderEntries(true)}
          >
            Show older reports ({entries.length - RECENT_AUDIT_LIMIT})
          </button>
        ) : null}
      </div>
    </section>
  );
}
