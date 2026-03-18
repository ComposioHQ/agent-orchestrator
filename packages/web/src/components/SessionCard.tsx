"use client";

import { memo, useState, useEffect, useRef } from "react";
import {
  type DashboardSession,
  type AttentionLevel,
  getAttentionLevel,
  isPRRateLimited,
  TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { cn } from "@/lib/cn";
import { getSessionTitle } from "@/lib/format";
import { CICheckList } from "./CIBadge";
import { ActivityDot } from "./ActivityDot";

interface SessionCardProps {
  session: DashboardSession;
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

const borderColorByLevel: Record<AttentionLevel, string> = {
  merge: "border-l-[var(--color-status-ready)]",
  respond: "border-l-[var(--color-status-error)]",
  review: "border-l-[var(--color-accent-orange)]",
  pending: "border-l-[var(--color-status-attention)]",
  working: "border-l-[var(--color-status-working)]",
  done: "border-l-[var(--color-border-default)]",
};

function SessionCardView({ session, onSend, onKill, onMerge, onRestore }: SessionCardProps) {
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

  const rateLimited = pr ? isPRRateLimited(pr) : false;
  const alerts = getAlerts(session);
  const isReadyToMerge = !rateLimited && pr?.mergeability.mergeable && pr.state === "open";
  const isTerminal =
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity));
  const isRestorable = isTerminal && session.status !== "merged";

  const title = getSessionTitle(session);

  return (
    <div
      className={cn(
        "session-card cursor-pointer border border-l-[3px]",
        "hover:border-[var(--color-border-strong)]",
        borderColorByLevel[level],
        isReadyToMerge
          ? "card-merge-ready border-[color-mix(in_srgb,var(--color-status-ready)_30%,transparent)]"
          : "border-[var(--color-border-default)]",
        expanded && "border-[var(--color-border-strong)]",
        pr?.state === "merged" && "opacity-55",
      )}
      style={{
        borderRadius: 7,
        background:
          expanded && !isReadyToMerge
            ? "var(--card-expanded-bg)"
            : undefined,
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, textarea")) return;
        setExpanded(!expanded);
      }}
    >
      {/* Header row: dot + session ID + terminal link */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <ActivityDot activity={session.activity} />
        <span className="font-[var(--font-mono)] text-[11px] tracking-wide text-[var(--color-text-muted)]">
          {session.id}
        </span>
        <div className="flex-1" />
        {isRestorable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRestore?.(session.id);
            }}
            className="rounded border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] px-2 py-0.5 text-[11px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-tint-blue)]"
          >
            restore
          </button>
        )}
        {!isTerminal && (
          <a
            href={`/sessions/${encodeURIComponent(session.id)}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-2.5 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:no-underline"
          >
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 10l4 2-4 2" />
              <path d="M14 14h4" />
            </svg>
            terminal
          </a>
        )}
      </div>

      {/* Title — its own row, bigger, can wrap */}
      <div className="px-4 pb-3">
        <p
          className={cn(
            "leading-snug [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden",
            level === "working"
              ? "text-[13px] font-medium text-[var(--color-text-secondary)]"
              : "text-[14px] font-semibold text-[var(--color-text-primary)]",
          )}
        >
          {title}
        </p>
      </div>

      {/* Meta row: branch + PR# + diff size */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2.5">
        {session.branch && (
          <span className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
            {session.branch}
          </span>
        )}
        {pr && (
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="font-[var(--font-mono)] text-[11px] font-bold text-[var(--color-text-primary)] underline-offset-2 hover:underline"
          >
            #{pr.number}
          </a>
        )}
        {pr && !rateLimited && (
          <span className="inline-flex items-center rounded-full bg-[var(--color-chip-bg)] px-2 py-0.5 font-[var(--font-mono)] text-[10px] font-semibold text-[var(--color-text-muted)]">
            +{pr.additions} -{pr.deletions}
            {diffSizeLabel(pr.additions, pr.deletions)}
          </span>
        )}
      </div>

      {/* Rate limited indicator */}
      {rateLimited && pr?.state === "open" && (
        <div className="px-4 pb-3">
          <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
            <svg
              className="h-3 w-3 text-[var(--color-text-tertiary)]"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            PR data rate limited
          </span>
        </div>
      )}

      {/* Merge button or alert tags */}
      {!rateLimited && (alerts.length > 0 || isReadyToMerge) && (
        <div className="px-4 pb-3.5 pt-0.5">
          {isReadyToMerge && pr ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMerge?.(pr.number);
              }}
              className="inline-flex items-center gap-1.5 rounded-[5px] border-0 bg-[var(--color-status-ready)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-text-inverse)] transition-[filter,transform] duration-[100ms] hover:-translate-y-px hover:brightness-110"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              Merge PR #{pr.number}
            </button>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {alerts.map((alert) => (
                <span
                  key={alert.key}
                  className="inline-flex items-stretch overflow-hidden border"
                  style={{ borderColor: alert.borderColor ?? alert.color ?? "var(--color-border-default)" }}
                >
                  <a
                    href={alert.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-0.5 font-[var(--font-mono)] text-[11px] font-medium hover:brightness-125 hover:no-underline",
                      alert.className,
                    )}
                    style={alert.color ? { color: alert.color } : undefined}
                  >
                    {alert.count !== undefined && <span className="font-bold">{alert.count}</span>}
                    {alert.label}
                  </a>
                  {alert.actionLabel && session.activity !== "active" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAction(alert.key, alert.actionMessage ?? "");
                      }}
                      disabled={sendingAction === alert.key}
                      className={cn(
                        "border-l px-2 py-0.5 font-[var(--font-mono)] text-[11px] font-medium transition-colors disabled:opacity-50",
                        alert.actionClassName,
                      )}
                      style={{ borderColor: alert.borderColor ?? alert.color ?? "var(--color-border-default)" }}
                    >
                      {sendingAction === alert.key ? "sent!" : alert.actionLabel}
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Expandable detail panel */}
      {expanded && (
        <div className="border-t border-[var(--color-border-subtle)] px-4 py-3.5">
          {session.summary && pr?.title && session.summary !== pr.title && (
            <DetailSection label="Summary">
              <p className="text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
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
                className="text-[12px] text-[var(--color-accent)] hover:underline"
              >
                {session.issueLabel || session.issueUrl}
                {session.issueTitle && `: ${session.issueTitle}`}
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
                  <div key={c.url} className="flex items-center gap-2 text-[12px]">
                    <span className="w-3 shrink-0 text-center text-[var(--color-status-error)]">
                      ●
                    </span>
                    <span className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[10px] text-[var(--color-text-secondary)]">
                      {c.path}
                    </span>
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-[11px] text-[var(--color-accent)] hover:underline"
                    >
                      view →
                    </a>
                  </div>
                ))}
              </div>
            </DetailSection>
          )}

          {pr && (
            <DetailSection label="PR">
              <p className="text-[12px] text-[var(--color-text-secondary)]">
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {pr.title}
                </a>
                <br />
                <span className="text-[var(--color-status-ready)]">+{pr.additions}</span>{" "}
                <span className="text-[var(--color-status-error)]">-{pr.deletions}</span>
                {" · "}mergeable: {pr.mergeability.mergeable ? "yes" : "no"}
                {" · "}review: {pr.reviewDecision}
              </p>
            </DetailSection>
          )}

          {!pr && (
            <p className="text-[12px] text-[var(--color-text-tertiary)]">
              No PR associated with this session.
            </p>
          )}

          <div className="mt-3 flex gap-2 border-t border-[var(--color-border-subtle)] pt-3">
            {isRestorable && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore?.(session.id);
                }}
                className="rounded border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] px-2.5 py-1 text-[11px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-tint-blue)]"
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
                className="rounded border border-[color-mix(in_srgb,var(--color-status-error)_35%,transparent)] px-2.5 py-1 text-[11px] text-[var(--color-status-error)] transition-colors hover:bg-[var(--color-tint-red)]"
              >
                terminate
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function areSessionCardPropsEqual(prev: SessionCardProps, next: SessionCardProps): boolean {
  return (
    prev.session === next.session &&
    prev.onSend === next.onSend &&
    prev.onKill === next.onKill &&
    prev.onMerge === next.onMerge &&
    prev.onRestore === next.onRestore
  );
}

export const SessionCard = memo(SessionCardView, areSessionCardPropsEqual);

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function diffSizeLabel(additions: number, deletions: number): string {
  const size = additions + deletions;
  return size > 1000 ? " XL" : size > 500 ? " L" : size > 200 ? " M" : size > 50 ? " S" : " XS";
}

interface Alert {
  key: string;
  label: string;
  className: string;
  color?: string;
  borderColor?: string;
  url: string;
  count?: number;
  actionLabel?: string;
  actionMessage?: string;
  actionClassName?: string;
}

function getAlerts(session: DashboardSession): Alert[] {
  const pr = session.pr;
  if (!pr || pr.state !== "open") return [];
  if (isPRRateLimited(pr)) return [];

  const alerts: Alert[] = [];

  if (pr.ciStatus === CI_STATUS.FAILING) {
    const failedCheck = pr.ciChecks.find((c) => c.status === "failed");
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    if (failCount === 0) {
      alerts.push({
        key: "ci-unknown",
        label: "CI unknown",
        className: "",
        color: "var(--color-alert-ci-unknown)",
        url: pr.url + "/checks",
      });
    } else {
      alerts.push({
        key: "ci-fail",
        label: `${failCount} CI check${failCount > 1 ? "s" : ""} failing`,
        className: "",
        color: "var(--color-alert-ci)",
        borderColor: "var(--color-alert-ci)",
        url: failedCheck?.url ?? pr.url + "/checks",
        actionLabel: "ask to fix",
        actionMessage: `Please fix the failing CI checks on ${pr.url}`,
        actionClassName:
          "bg-[var(--color-alert-ci)] text-white hover:brightness-110",
      });
    }
  }

  if (pr.reviewDecision === "changes_requested") {
    alerts.push({
      key: "changes",
      label: "changes requested",
      className: "",
      color: "var(--color-alert-changes)",
      url: pr.url,
    });
  } else if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
    alerts.push({
      key: "review",
      label: "needs review",
      className: "underline",
      color: "var(--color-alert-review)",
      url: pr.url,
      actionLabel: "ask to post",
      actionMessage: `Post ${pr.url} on slack asking for a review.`,
      actionClassName:
        "bg-[var(--color-alert-review-bg)] text-white hover:brightness-110",
    });
  }

  if (!pr.mergeability.noConflicts) {
    alerts.push({
      key: "conflict",
      label: "merge conflict",
      className: "",
      color: "var(--color-alert-conflict)",
      url: pr.url,
      actionLabel: "ask to fix",
      actionMessage: `Please resolve the merge conflicts on ${pr.url} by rebasing on the base branch`,
      actionClassName:
        "border-[var(--color-alert-conflict)] bg-[var(--color-alert-conflict-bg)] text-[var(--color-alert-conflict)] hover:brightness-110",
    });
  }

  if (pr.unresolvedThreads > 0) {
    const firstUrl = pr.unresolvedComments[0]?.url ?? pr.url + "/files";
    alerts.push({
      key: "comments",
      label: "unresolved comments",
      count: pr.unresolvedThreads,
      className: "",
      color: "var(--color-alert-comment)",
      borderColor: "var(--color-alert-comment)",
      url: firstUrl,
      actionLabel: "ask to resolve",
      actionMessage: `Please address all unresolved review comments on ${pr.url}`,
      actionClassName:
        "border-[var(--color-alert-comment)] bg-[var(--color-alert-comment-bg)] text-[var(--color-alert-comment)] hover:brightness-110",
    });
  }

  return alerts;
}
