"use client";

import { useEffect, useRef, useState } from "react";
import { CI_STATUS } from "@aoagents/ao-core/types";
import { cn } from "@/lib/cn";
import { isPRMergeReady, type DashboardPR } from "@/lib/types";
import { cleanBugbotComment } from "./session-detail-utils";

interface SessionDetailPRCardProps {
  pr: DashboardPR;
  metadata: Record<string, string>;
  lifecyclePrReason?: string;
  onAskAgentToFix: (
    comment: { url: string; path: string; body: string },
    onSuccess: () => void,
    onError: () => void,
  ) => Promise<void>;
}

interface BlockerChip {
  icon: string;
  text: string;
  variant: "fail" | "warn" | "muted";
  notified?: boolean;
}

function buildBlockerChips(
  pr: DashboardPR,
  metadata: Record<string, string>,
  lifecyclePrReason?: string,
): BlockerChip[] {
  const chips: BlockerChip[] = [];

  const ciNotified = Boolean(metadata["lastCIFailureDispatchHash"]);
  const conflictNotified = metadata["lastMergeConflictDispatched"] === "true";
  const reviewNotified = Boolean(metadata["lastPendingReviewDispatchHash"]);
  const lifecycleStatus = metadata["status"];

  const ciIsFailing = pr.ciStatus === CI_STATUS.FAILING;
  const hasChangesRequested =
    pr.reviewDecision === "changes_requested" ||
    lifecyclePrReason === "changes_requested" ||
    lifecycleStatus === "changes_requested";
  const hasConflicts = pr.state !== "merged" && !pr.mergeability.noConflicts;

  if (ciIsFailing) {
    const failCount = pr.ciChecks.filter((check) => check.status === "failed").length;
    chips.push({
      icon: "\u2717",
      variant: "fail",
      text: failCount > 0 ? `${failCount} check${failCount !== 1 ? "s" : ""} failing` : "CI failing",
      notified: ciNotified,
    });
  } else if (pr.ciStatus === CI_STATUS.PENDING) {
    chips.push({ icon: "\u25CF", variant: "warn", text: "CI pending" });
  }

  if (hasChangesRequested) {
    chips.push({
      icon: "\u2717",
      variant: "fail",
      text: "Changes requested",
      notified: reviewNotified,
    });
  } else if (!pr.mergeability.approved) {
    chips.push({ icon: "\u25CB", variant: "muted", text: "Awaiting reviewer" });
  }

  if (hasConflicts) {
    chips.push({
      icon: "\u2717",
      variant: "fail",
      text: "Merge conflicts",
      notified: conflictNotified,
    });
  }

  if (pr.isDraft) {
    chips.push({ icon: "\u25CB", variant: "muted", text: "Draft" });
  }

  return chips;
}

export function SessionDetailPRCard({
  pr,
  metadata,
  lifecyclePrReason,
  onAskAgentToFix,
}: SessionDetailPRCardProps) {
  const [sendingComments, setSendingComments] = useState<Set<string>>(new Set());
  const [sentComments, setSentComments] = useState<Set<string>>(new Set());
  const [errorComments, setErrorComments] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const handleAskAgentToFix = async (comment: { url: string; path: string; body: string }) => {
    setSentComments((prev) => {
      const next = new Set(prev);
      next.delete(comment.url);
      return next;
    });
    setErrorComments((prev) => {
      const next = new Set(prev);
      next.delete(comment.url);
      return next;
    });
    setSendingComments((prev) => new Set(prev).add(comment.url));

    await onAskAgentToFix(
      comment,
      () => {
        setSendingComments((prev) => {
          const next = new Set(prev);
          next.delete(comment.url);
          return next;
        });
        setSentComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setSentComments((prev) => {
            const next = new Set(prev);
            next.delete(comment.url);
            return next;
          });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
      () => {
        setSendingComments((prev) => {
          const next = new Set(prev);
          next.delete(comment.url);
          return next;
        });
        setErrorComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setErrorComments((prev) => {
            const next = new Set(prev);
            next.delete(comment.url);
            return next;
          });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
    );
  };

  const allGreen = isPRMergeReady(pr);
  const blockerIssues = buildBlockerChips(pr, metadata, lifecyclePrReason);
  const fileCount = pr.changedFiles ?? 0;

  return (
    <div className={cn("session-detail-pr-card", allGreen && "session-detail-pr-card--green")}>
      <div className="session-detail-pr-card__row">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="session-detail-pr-card__title-link"
        >
          PR #{pr.number}: {pr.title}
        </a>
        <span className="session-detail-pr-card__diff-stats">
          <span className="session-detail-diff--add">+{pr.additions}</span>{" "}
          <span className="session-detail-diff--del">-{pr.deletions}</span>
        </span>
        {fileCount > 0 ? (
          <span className="session-detail-pr-card__diff-label">
            {fileCount} file{fileCount !== 1 ? "s" : ""}
          </span>
        ) : null}
        {pr.isDraft ? <span className="session-detail-pr-card__diff-label">Draft</span> : null}
        {pr.state === "merged" ? (
          <span className="session-detail-pr-card__diff-label">Merged</span>
        ) : null}
      </div>

      <div className="session-detail-pr-card__details">
        {allGreen ? (
          <div className="session-detail-merge-banner">
            <svg
              width="11"
              height="11"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Ready to merge
          </div>
        ) : (
          blockerIssues.map((issue) => (
            <span
              key={issue.text}
              className={cn(
                "session-detail-blocker-chip",
                issue.variant === "fail" && "session-detail-blocker-chip--fail",
                issue.variant === "warn" && "session-detail-blocker-chip--warn",
                issue.variant === "muted" && "session-detail-blocker-chip--muted",
              )}
            >
              {issue.icon} {issue.text}
              {issue.notified ? (
                <span className="session-detail-blocker-chip__note">· notified</span>
              ) : null}
            </span>
          ))
        )}

        {pr.ciChecks.length > 0 ? (
          <>
            <div className="session-detail-pr-sep" />
            {pr.ciChecks.map((check, index) => {
              const key = check.url ?? `${check.name}-${index}`;
              const chip = (
                <span
                  className={cn(
                    "session-detail-ci-chip",
                    check.status === "passed" && "session-detail-ci-chip--pass",
                    check.status === "failed" && "session-detail-ci-chip--fail",
                    check.status === "pending" && "session-detail-ci-chip--pending",
                    check.status !== "passed" &&
                      check.status !== "failed" &&
                      check.status !== "pending" &&
                      "session-detail-ci-chip--queued",
                  )}
                >
                  {check.status === "passed"
                    ? "\u2713"
                    : check.status === "failed"
                      ? "\u2717"
                      : check.status === "pending"
                        ? "\u25CF"
                        : "\u25CB"}{" "}
                  {check.name}
                </span>
              );
              return check.url ? (
                <a
                  key={key}
                  href={check.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:no-underline"
                  onClick={(event) => event.stopPropagation()}
                >
                  {chip}
                </a>
              ) : (
                <span key={key}>{chip}</span>
              );
            })}
          </>
        ) : null}
      </div>

      {pr.unresolvedComments.length > 0 ? (
        <details className="session-detail-comments-strip">
          <summary>
            <div className="session-detail-comments-strip__toggle">
              <svg
                className="session-detail-comments-strip__chevron"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                viewBox="0 0 24 24"
              >
                <path d="M9 5l7 7-7 7" />
              </svg>
              <span className="session-detail-comments-strip__label">Unresolved Comments</span>
              <span className="session-detail-comments-strip__count">{pr.unresolvedThreads}</span>
              <span className="session-detail-comments-strip__hint">click to expand</span>
            </div>
          </summary>
          <div className="session-detail-comments-strip__body">
            {pr.unresolvedComments.map((comment, index) => {
              const { title, description } = cleanBugbotComment(comment.body);
              return (
                <details key={comment.url} className="session-detail-comment" open={index === 0}>
                  <summary>
                    <div className="session-detail-comment__row">
                      <svg
                        className="session-detail-comment__chevron"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <path d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="session-detail-comment__title">{title}</span>
                      <span className="session-detail-comment__author">· {comment.author}</span>
                      <a
                        href={comment.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        className="session-detail-comment__view"
                      >
                        view &rarr;
                      </a>
                    </div>
                  </summary>
                  <div className="session-detail-comment__body">
                    <div className="session-detail-comment__file">{comment.path}</div>
                    <p className="session-detail-comment__text">{description}</p>
                    <button
                      onClick={() => handleAskAgentToFix(comment)}
                      disabled={sendingComments.has(comment.url)}
                      className={cn(
                        "session-detail-comment__fix-btn",
                        sentComments.has(comment.url) && "session-detail-comment__fix-btn--sent",
                        errorComments.has(comment.url) && "session-detail-comment__fix-btn--error",
                      )}
                    >
                      {sendingComments.has(comment.url)
                        ? "Sending\u2026"
                        : sentComments.has(comment.url)
                          ? "Sent \u2713"
                          : errorComments.has(comment.url)
                            ? "Failed"
                            : "Ask Agent to Fix"}
                    </button>
                  </div>
                </details>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}
