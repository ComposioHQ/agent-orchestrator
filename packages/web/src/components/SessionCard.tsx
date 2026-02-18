"use client";

import { useState, useEffect, useRef } from "react";
import {
  type DashboardSession,
  type AttentionLevel,
  getAttentionLevel,
  TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { cn } from "@/lib/cn";
import { PRStatus } from "./PRStatus";
import { CICheckList } from "./CIBadge";

interface SessionCardProps {
  session: DashboardSession;
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

const activityIcon: Record<string, string> = {
  active: "\u26A1",
  ready: "\uD83D\uDFE2",
  idle: "\uD83D\uDCA4",
  waiting_input: "\u2753",
  blocked: "\uD83D\uDEA7",
  exited: "\uD83D\uDC80",
};

const borderColorByLevel: Record<AttentionLevel, string> = {
  merge: "border-l-[var(--color-accent-green)]",
  respond: "border-l-[var(--color-accent-red)]",
  review: "border-l-[var(--color-accent-orange)]",
  pending: "border-l-[var(--color-accent-yellow)]",
  working: "border-l-[var(--color-accent-blue)]",
  done: "border-l-[var(--color-border-default)]",
};

export function SessionCard({ session, onSend, onKill, onMerge, onRestore }: SessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [sendingAction, setSendingAction] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const level = getAttentionLevel(session);
  const pr = session.pr;

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleAction = async (action: string, message: string) => {
    setSendingAction(action);
    onSend?.(session.id, message);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setSendingAction(null), 2000);
  };

  const alerts = getAlerts(session);
  const isReadyToMerge = pr?.mergeability.mergeable && pr.state === "open";
  const isTerminal =
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity));
  // UI restore button: more permissive than core isRestorable() — shows restore
  // when agent has exited even if status is "working" (agent crashed mid-work).
  // Only block "merged" (server-side restore will reject anyway).
  const isRestorable = isTerminal && session.status !== "merged";

  return (
    <div
      className={cn(
        "cursor-pointer border border-[var(--color-border-default)] border-l-[3px] bg-[var(--color-bg-secondary)] transition-colors hover:border-[var(--color-border-emphasis)]",
        borderColorByLevel[level],
        expanded && "border-[var(--color-border-emphasis)]",
        isReadyToMerge && "border-[rgba(63,185,80,0.5)]",
        pr?.state === "merged" && "opacity-75",
      )}
      style={{ borderRadius: 10 }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, textarea")) return;
        setExpanded(!expanded);
      }}
    >
      {/* Top row */}
      <div className="flex items-center gap-2.5 px-4 pt-3 pb-1.5">
        <span
          className={cn(
            "shrink-0 text-sm",
            session.activity === "active" && "animate-[pulse_2s_ease-in-out_infinite]",
          )}
        >
          {(session.activity && activityIcon[session.activity]) ?? "\u2753"}
        </span>
        <span className="shrink-0 text-[13px] font-semibold text-[var(--color-text-secondary)]">
          {session.id}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text-primary)]">
          {pr?.title ?? session.summary ?? session.status}
        </span>
        {isRestorable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRestore?.(session.id);
            }}
            className="shrink-0 rounded-md border border-[rgba(88,166,255,0.4)] px-2.5 py-0.5 text-[11px] text-[var(--color-accent-blue)] transition-colors hover:bg-[rgba(88,166,255,0.15)]"
          >
            restore session
          </button>
        )}
        {!isTerminal && (
          <a
            href={`/sessions/${encodeURIComponent(session.id)}`}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 rounded-md border border-[var(--color-border-default)] px-2.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent-blue)] hover:text-[var(--color-accent-blue)] hover:no-underline"
          >
            terminal
          </a>
        )}
      </div>

      {/* Meta row: branch + PR pills */}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2 pl-[42px]">
        {session.branch && (
          <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-muted)]">
            {session.branch}
          </span>
        )}
        {session.branch && pr && (
          <span className="text-[10px] text-[var(--color-border-default)]">&middot;</span>
        )}
        {pr && <PRStatus pr={pr} />}
      </div>

      {/* Alert tags */}
      {(alerts.length > 0 || isReadyToMerge) && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 pl-[42px]">
          {isReadyToMerge && pr ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMerge?.(pr.number);
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-[rgba(63,185,80,0.4)] bg-[rgba(63,185,80,0.2)] px-3 py-1 text-[13px] font-bold text-[var(--color-accent-green)] hover:brightness-125"
            >
              merge PR #{pr.number}
            </button>
          ) : (
            alerts.map((alert) => (
              <span key={alert.key}>
                <a
                  href={alert.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-3 py-0.5 text-xs font-bold hover:brightness-125",
                    alert.className,
                  )}
                >
                  {alert.count !== undefined && (
                    <span className="text-sm font-extrabold">{alert.count}</span>
                  )}
                  {alert.label}
                </a>
                {alert.actionLabel && session.activity !== "active" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAction(alert.key, alert.actionMessage ?? "");
                    }}
                    disabled={sendingAction === alert.key}
                    className="ml-1.5 rounded-md border border-[rgba(88,166,255,0.3)] px-2.5 py-0.5 text-[11px] text-[var(--color-accent-blue)] transition-colors hover:bg-[rgba(88,166,255,0.1)] disabled:opacity-50"
                  >
                    {sendingAction === alert.key ? "sent!" : alert.actionLabel}
                  </button>
                )}
              </span>
            ))
          )}
        </div>
      )}

      {/* Expandable detail panel */}
      {expanded && (
        <div className="border-t border-[var(--color-border-muted)] px-4 py-3 pl-[42px]">
          {session.summary && pr?.title && session.summary !== pr.title && (
            <DetailSection label="Summary">
              <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
                {session.summary}
              </p>
            </DetailSection>
          )}

          {session.issueUrl && (
            <DetailSection label="Issue">
              <a
                href={session.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--color-accent-blue)] hover:underline"
              >
                {session.issueLabel || session.issueUrl}
              </a>
            </DetailSection>
          )}

          {pr && pr.ciChecks.length > 0 && (
            <DetailSection label="CI Checks">
              <CICheckList checks={pr.ciChecks} />
            </DetailSection>
          )}

          {pr && pr.unresolvedComments.length > 0 && (
            <DetailSection label="Unresolved Comments">
              <div className="space-y-1">
                {pr.unresolvedComments.map((c) => (
                  <div key={c.url} className="flex items-center gap-2 text-xs">
                    <span className="w-3.5 shrink-0 text-center text-[var(--color-accent-red)]">
                      {"\u25CF"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">
                      {c.path}
                    </span>
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-[11px] text-[var(--color-accent-blue)] hover:underline"
                    >
                      go to comment
                    </a>
                  </div>
                ))}
              </div>
            </DetailSection>
          )}

          {pr && (
            <DetailSection label="PR Details">
              <p className="text-xs text-[var(--color-text-secondary)]">
                <a href={pr.url} target="_blank" rel="noopener noreferrer">
                  {pr.title}
                </a>
                <br />
                <span className="text-[var(--color-accent-green)]">+{pr.additions}</span>{" "}
                <span className="text-[var(--color-accent-red)]">-{pr.deletions}</span>
                {" \u00B7 "}mergeable: {pr.mergeability.mergeable ? "yes" : "no"}
                {" \u00B7 "}review: {pr.reviewDecision}
              </p>
            </DetailSection>
          )}

          {!pr && (
            <p className="text-xs text-[var(--color-text-muted)]">
              No PR associated with this session.
            </p>
          )}

          <div className="mt-3 flex gap-2 border-t border-[var(--color-border-muted)] pt-3">
            {isRestorable && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore?.(session.id);
                }}
                className="rounded-md border border-[rgba(88,166,255,0.4)] px-2.5 py-0.5 text-[11px] text-[var(--color-accent-blue)] transition-colors hover:bg-[rgba(88,166,255,0.15)]"
              >
                restore session
              </button>
            )}
            {!isTerminal && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onKill?.(session.id);
                }}
                className="rounded-md border border-[rgba(248,81,73,0.4)] px-2.5 py-0.5 text-[11px] text-[var(--color-accent-red)] transition-colors hover:bg-[rgba(248,81,73,0.15)]"
              >
                terminate session
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      {children}
    </div>
  );
}

interface Alert {
  key: string;
  label: string;
  className: string;
  url: string;
  count?: number;
  actionLabel?: string;
  actionMessage?: string;
}

function getAlerts(session: DashboardSession): Alert[] {
  const pr = session.pr;
  if (!pr || pr.state !== "open") return [];

  const alerts: Alert[] = [];

  // CI failing
  if (pr.ciStatus === CI_STATUS.FAILING) {
    const failedCheck = pr.ciChecks.find((c) => c.status === "failed");
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;

    // If ciStatus is "failing" but no failed checks, the API likely failed
    if (failCount === 0) {
      alerts.push({
        key: "ci-unknown",
        label: "CI status unknown",
        className:
          "border-[rgba(210,153,34,0.3)] bg-[rgba(210,153,34,0.15)] text-[var(--color-accent-yellow)]",
        url: pr.url + "/checks",
      });
    } else {
      alerts.push({
        key: "ci-fail",
        label: `${failCount} CI check${failCount > 1 ? "s" : ""} failing`,
        className:
          "border-[rgba(248,81,73,0.3)] bg-[rgba(248,81,73,0.15)] text-[var(--color-accent-red)]",
        url: failedCheck?.url ?? pr.url + "/checks",
        actionLabel: "ask to fix CI",
        actionMessage: `Please fix the failing CI checks on ${pr.url}`,
      });
    }
  }

  // Changes requested
  if (pr.reviewDecision === "changes_requested") {
    alerts.push({
      key: "changes",
      label: "changes requested",
      className:
        "border-[rgba(248,81,73,0.3)] bg-[rgba(248,81,73,0.15)] text-[var(--color-accent-red)]",
      url: pr.url,
    });
  } else if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
    alerts.push({
      key: "review",
      label: "needs review",
      className:
        "border-[rgba(210,153,34,0.3)] bg-[rgba(210,153,34,0.15)] text-[var(--color-accent-yellow)]",
      url: pr.url,
      actionLabel: "ask to post for review",
      actionMessage: `Post ${pr.url} on slack asking for a review.`,
    });
  }

  // Merge conflict
  if (!pr.mergeability.noConflicts) {
    alerts.push({
      key: "conflict",
      label: "merge conflict",
      className:
        "border-[rgba(248,81,73,0.3)] bg-[rgba(248,81,73,0.15)] text-[var(--color-accent-red)]",
      url: pr.url,
      actionLabel: "ask to fix conflicts",
      actionMessage: `Please resolve the merge conflicts on ${pr.url} by rebasing on the base branch`,
    });
  }

  // Unresolved comments
  if (pr.unresolvedThreads > 0) {
    const firstUrl = pr.unresolvedComments[0]?.url ?? pr.url + "/files";
    alerts.push({
      key: "comments",
      label: "unresolved comments",
      count: pr.unresolvedThreads,
      className:
        "border-[rgba(248,81,73,0.3)] bg-[rgba(248,81,73,0.15)] text-[var(--color-accent-red)]",
      url: firstUrl,
      actionLabel: "ask to resolve",
      actionMessage: `Please address all unresolved review comments on ${pr.url}`,
    });
  }

  return alerts;
}
