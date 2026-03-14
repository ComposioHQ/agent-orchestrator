import { CI_STATUS } from "@composio/ao-core/types";
import {
  NON_RESTORABLE_STATUSES,
  TERMINAL_ACTIVITIES,
  TERMINAL_STATUSES,
  type DashboardPR,
  type DashboardSession,
  isPRRateLimited,
} from "@/lib/types";

export interface SessionAlertAction {
  key: string;
  label: string;
  className: string;
  url: string;
  count?: number;
  actionLabel?: string;
  actionMessage?: string;
}

export interface SessionActionAvailability {
  canSend: boolean;
  canKill: boolean;
  canRestore: boolean;
  canMerge: boolean;
}

export function getSessionAlerts(session: DashboardSession): SessionAlertAction[] {
  const pr = session.pr;
  if (!pr || pr.state !== "open") return [];
  if (isPRRateLimited(pr)) return [];

  const alerts: SessionAlertAction[] = [];

  if (pr.ciStatus === CI_STATUS.FAILING) {
    const failedCheck = pr.ciChecks.find((check) => check.status === "failed");
    const failCount = pr.ciChecks.filter((check) => check.status === "failed").length;
    if (failCount === 0) {
      alerts.push({
        key: "ci-unknown",
        label: "CI unknown",
        className:
          "border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] text-[var(--color-status-attention)]",
        url: `${pr.url}/checks`,
      });
    } else {
      alerts.push({
        key: "ci-fail",
        label: `${failCount} CI check${failCount > 1 ? "s" : ""} failing`,
        className:
          "border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] text-[var(--color-status-error)]",
        url: failedCheck?.url ?? `${pr.url}/checks`,
        actionLabel: "ask to fix",
        actionMessage: `Please fix the failing CI checks on ${pr.url}`,
      });
    }
  }

  if (pr.reviewDecision === "changes_requested") {
    alerts.push({
      key: "changes",
      label: "changes requested",
      className:
        "border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] text-[var(--color-status-error)]",
      url: pr.url,
    });
  } else if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
    alerts.push({
      key: "review",
      label: "needs review",
      className:
        "border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] text-[var(--color-status-attention)]",
      url: pr.url,
      actionLabel: "ask to post",
      actionMessage: `Post ${pr.url} on slack asking for a review.`,
    });
  }

  if (!pr.mergeability.noConflicts) {
    alerts.push({
      key: "conflict",
      label: "merge conflict",
      className:
        "border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] text-[var(--color-status-error)]",
      url: pr.url,
      actionLabel: "ask to fix",
      actionMessage: `Please resolve the merge conflicts on ${pr.url} by rebasing on the base branch`,
    });
  }

  if (pr.unresolvedThreads > 0) {
    const firstUrl = pr.unresolvedComments[0]?.url ?? `${pr.url}/files`;
    alerts.push({
      key: "comments",
      label: "unresolved comments",
      count: pr.unresolvedThreads,
      className:
        "border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] text-[var(--color-status-error)]",
      url: firstUrl,
      actionLabel: "ask to resolve",
      actionMessage: `Please address all unresolved review comments on ${pr.url}`,
    });
  }

  return alerts;
}

export function canMergePR(pr: DashboardPR | null | undefined): pr is DashboardPR {
  return Boolean(
    pr &&
      pr.state === "open" &&
      !isPRRateLimited(pr) &&
      pr.mergeability.mergeable &&
      pr.mergeability.ciPassing &&
      pr.mergeability.approved &&
      pr.mergeability.noConflicts,
  );
}

export function isSessionTerminal(session: DashboardSession): boolean {
  return (
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity))
  );
}

export function canRestoreSession(session: DashboardSession): boolean {
  if (!isSessionTerminal(session)) return false;
  if (NON_RESTORABLE_STATUSES.has(session.status)) return false;
  return session.status !== "merged" && session.pr?.state !== "merged";
}

export function canKillSession(session: DashboardSession): boolean {
  return !isSessionTerminal(session);
}

export function canSendMessage(session: DashboardSession): boolean {
  return !isSessionTerminal(session);
}

export function getSessionActionAvailability(session: DashboardSession): SessionActionAvailability {
  return {
    canSend: canSendMessage(session),
    canKill: canKillSession(session),
    canRestore: canRestoreSession(session),
    canMerge: canMergePR(session.pr),
  };
}
