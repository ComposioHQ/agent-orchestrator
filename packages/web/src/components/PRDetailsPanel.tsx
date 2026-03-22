"use client";

import { useState, useEffect, useRef } from "react";
import { type DashboardPR, isPRMergeReady } from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { cn } from "@/lib/cn";
import { CIChecksPanel } from "./CIChecksPanel";
import { cleanBugbotComment, askAgentToFix } from "./session-detail-helpers";

interface PRDetailsPanelProps {
  pr: DashboardPR;
  sessionId: string;
}

export function PRDetailsPanel({ pr, sessionId }: PRDetailsPanelProps) {
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

    await askAgentToFix(
      sessionId,
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

  const borderColor = allGreen
    ? "rgba(63,185,80,0.4)"
    : pr.state === "merged"
      ? "rgba(163,113,247,0.3)"
      : "var(--color-border-default)";

  return (
    <div className="detail-card mb-6 overflow-hidden rounded-[var(--radius-lg)] border" style={{ borderColor }}>
      {/* Title row */}
      <div className="border-b border-[var(--color-border-subtle)] px-5 py-3.5">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] font-semibold text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-accent)] hover:no-underline"
        >
          PR #{pr.number}: {pr.title}
        </a>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span>
            <span className="text-[var(--color-status-ready)]">+{pr.additions}</span>{" "}
            <span className="text-[var(--color-status-error)]">-{pr.deletions}</span>
          </span>
          {pr.isDraft && (
            <>
              <span className="text-[var(--color-text-tertiary)]">&middot;</span>
              <span className="font-medium text-[var(--color-text-tertiary)]">Draft</span>
            </>
          )}
          {pr.state === "merged" && (
            <>
              <span className="text-[var(--color-text-tertiary)]">&middot;</span>
              <span
                className="rounded-full bg-[rgba(163,113,247,0.12)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-violet)]"
              >
                Merged
              </span>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4">
        {/* Ready-to-merge banner */}
        {allGreen ? (
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[rgba(63,185,80,0.25)] bg-[rgba(63,185,80,0.07)] px-3.5 py-2.5">
            <svg
              className="h-4 w-4 shrink-0 text-[var(--color-status-ready)]"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span className="text-[13px] font-semibold text-[var(--color-status-ready)]">
              Ready to merge
            </span>
          </div>
        ) : (
          <IssuesList pr={pr} />
        )}

        {/* CI Checks */}
        <CIChecksPanel checks={pr.ciChecks} />

        {/* Unresolved comments */}
        {pr.unresolvedComments.length > 0 && (
          <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
            <h4 className="mb-2.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              Unresolved Comments
              <span
                className="rounded-full bg-[rgba(248,81,73,0.12)] px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal text-[var(--color-status-error)]"
              >
                {pr.unresolvedThreads}
              </span>
            </h4>
            <div className="space-y-1">
              {pr.unresolvedComments.map((c) => (
                <CommentDisclosure
                  key={c.url}
                  comment={c}
                  onAskAgentToFix={handleAskAgentToFix}
                  isSending={sendingComments.has(c.url)}
                  isSent={sentComments.has(c.url)}
                  isError={errorComments.has(c.url)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Issues list (pre-merge blockers) ─────────────────────────────────

function IssuesList({ pr }: { pr: DashboardPR }) {
  const issues: Array<{ icon: string; color: string; text: string }> = [];

  if (pr.ciStatus === CI_STATUS.FAILING) {
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    issues.push({
      icon: "\u2717",
      color: "var(--color-status-error)",
      text:
        failCount > 0
          ? `CI failing \u2014 ${failCount} check${failCount !== 1 ? "s" : ""} failed`
          : "CI failing",
    });
  } else if (pr.ciStatus === CI_STATUS.PENDING) {
    issues.push({ icon: "\u25CF", color: "var(--color-status-attention)", text: "CI pending" });
  }

  if (pr.reviewDecision === "changes_requested") {
    issues.push({ icon: "\u2717", color: "var(--color-status-error)", text: "Changes requested" });
  } else if (!pr.mergeability.approved) {
    issues.push({
      icon: "\u25CB",
      color: "var(--color-text-tertiary)",
      text: "Not approved \u2014 awaiting reviewer",
    });
  }

  if (pr.state !== "merged" && !pr.mergeability.noConflicts) {
    issues.push({ icon: "\u2717", color: "var(--color-status-error)", text: "Merge conflicts" });
  }

  if (!pr.mergeability.mergeable && issues.length === 0) {
    issues.push({ icon: "\u25CB", color: "var(--color-text-tertiary)", text: "Not mergeable" });
  }

  if (pr.unresolvedThreads > 0) {
    issues.push({
      icon: "\u25CF",
      color: "var(--color-status-attention)",
      text: `${pr.unresolvedThreads} unresolved comment${pr.unresolvedThreads !== 1 ? "s" : ""}`,
    });
  }

  if (pr.isDraft) {
    issues.push({ icon: "\u25CB", color: "var(--color-text-tertiary)", text: "Draft PR" });
  }

  if (issues.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        Blockers
      </h4>
      {issues.map((issue) => (
        <div key={issue.text} className="flex items-center gap-2.5 text-[12px]">
          <span className="w-3 shrink-0 text-center text-[11px]" style={{ color: issue.color }}>
            {issue.icon}
          </span>
          <span className="text-[var(--color-text-secondary)]">{issue.text}</span>
        </div>
      ))}
    </div>
  );
}

function CommentDisclosure({
  comment: c,
  onAskAgentToFix,
  isSending,
  isSent,
  isError,
}: {
  comment: { url: string; path: string; author: string; body: string };
  onAskAgentToFix: (c: { url: string; path: string; author: string; body: string }) => void;
  isSending: boolean;
  isSent: boolean;
  isError: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { title, description } = cleanBugbotComment(c.body);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[rgba(255,255,255,0.04)]"
      >
        <svg
          className={cn(
            "h-3 w-3 shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-150",
            open && "rotate-90",
          )}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M9 5l7 7-7 7" />
        </svg>
        <span className="font-medium text-[var(--color-text-secondary)]">{title}</span>
        <span className="text-[var(--color-text-tertiary)]">· {c.author}</span>
        <a
          href={c.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="ml-auto text-[10px] text-[var(--color-accent)] hover:underline"
        >
          view →
        </a>
      </button>
      {open && (
        <div className="ml-5 mt-1 space-y-1.5 px-2 pb-2">
          <div className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-tertiary)]">{c.path}</div>
          <p className="border-l-2 border-[var(--color-border-default)] pl-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
            {description}
          </p>
          <button
            onClick={() => onAskAgentToFix(c)}
            disabled={isSending}
            className={cn(
              "mt-1.5 rounded-[var(--radius-sm)] px-3 py-1 text-[11px] font-semibold transition-all",
              isSent
                ? "bg-[var(--color-status-ready)] text-white"
                : isError
                  ? "bg-[var(--color-status-error)] text-white"
                  : "bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50",
            )}
          >
            {isSending ? "Sending\u2026" : isSent ? "Sent \u2713" : isError ? "Failed" : "Ask Agent to Fix"}
          </button>
        </div>
      )}
    </div>
  );
}
