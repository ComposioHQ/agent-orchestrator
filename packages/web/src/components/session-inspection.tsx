"use client";

import { useEffect, useState } from "react";
import { CI_STATUS } from "@composio/ao-core/types";
import { cn } from "@/lib/cn";
import { type DashboardPR, type DashboardSession, isPRMergeReady, isPRRateLimited } from "@/lib/types";
import { ActivityDot } from "./ActivityDot";
import { CICheckList } from "./CIBadge";

const activityMeta: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--color-status-working)" },
  ready: { label: "Ready", color: "var(--color-status-ready)" },
  idle: { label: "Idle", color: "var(--color-status-idle)" },
  waiting_input: { label: "Waiting for input", color: "var(--color-status-attention)" },
  blocked: { label: "Blocked", color: "var(--color-status-error)" },
  exited: { label: "Exited", color: "var(--color-status-error)" },
};

export interface InspectionLinkChip {
  href?: string;
  key: string;
  label: string;
  mono?: boolean;
  tone?: "accent" | "default";
}

export interface PRStatusBadge {
  key: string;
  label: string;
  tone: "danger" | "muted" | "neutral" | "success" | "warning";
}

export interface PRBlocker {
  color: string;
  icon: string;
  text: string;
}

export function humanizeStatus(status: string): string {
  return status
    .replace(/_/g, " ")
    .replace(/\bci\b/gi, "CI")
    .replace(/\bpr\b/gi, "PR")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function relativeTime(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime();
  if (!iso || Number.isNaN(ms)) return "unknown";
  const diff = now - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function getSessionActivity(session: DashboardSession): { color: string; label: string } {
  return (session.activity && activityMeta[session.activity]) ?? {
    label: session.activity ?? "unknown",
    color: "var(--color-text-muted)",
  };
}

export function buildGitHubBranchUrl(pr: DashboardPR): string {
  return `https://github.com/${pr.owner}/${pr.repo}/tree/${pr.branch}`;
}

export function buildGitHubRepoUrl(pr: DashboardPR): string {
  return `https://github.com/${pr.owner}/${pr.repo}`;
}

export function cleanBugbotComment(body: string): { description: string; title: string } {
  const isBugbot = body.includes("<!-- DESCRIPTION START -->") || body.includes("### ");
  if (isBugbot) {
    const titleMatch = body.match(/###\s+(.+?)(?:\n|$)/);
    const title = titleMatch ? titleMatch[1].replace(/\*\*/g, "").trim() : "Comment";
    const descMatch = body.match(
      /<!-- DESCRIPTION START -->\s*([\s\S]*?)\s*<!-- DESCRIPTION END -->/,
    );
    const description = descMatch ? descMatch[1].trim() : body.split("\n")[0] || "No description";
    return { title, description };
  }
  return { title: "Comment", description: body.trim() };
}

export function getSessionInspectionChips(session: DashboardSession): InspectionLinkChip[] {
  const chips: InspectionLinkChip[] = [];

  chips.push({
    key: "project",
    label: session.projectId,
    href: session.pr ? buildGitHubRepoUrl(session.pr) : undefined,
  });

  if (session.pr) {
    chips.push({
      key: "pr",
      label: `PR #${session.pr.number}`,
      href: session.pr.url,
      tone: "accent",
    });
  }

  if (session.branch) {
    chips.push({
      key: "branch",
      label: session.branch,
      href: session.pr ? buildGitHubBranchUrl(session.pr) : undefined,
      mono: true,
    });
  }

  if (session.issueUrl) {
    chips.push({
      key: "issue",
      label: session.issueLabel || session.issueUrl,
      href: session.issueUrl,
    });
  }

  return chips;
}

export function getSessionMetaSummary(session: DashboardSession, now = Date.now()): string[] {
  const meta = [humanizeStatus(session.status)];
  meta.push(`created ${relativeTime(session.createdAt, now)}`);
  meta.push(`active ${relativeTime(session.lastActivityAt, now)}`);
  return meta;
}

export function getPRStatusBadges(pr: DashboardPR): PRStatusBadge[] {
  const rateLimited = isPRRateLimited(pr);
  const badges: PRStatusBadge[] = [];

  if (pr.state === "merged") {
    badges.push({ key: "merged", label: "merged", tone: "success" });
    return badges;
  }

  if (pr.isDraft && pr.state === "open") {
    badges.push({ key: "draft", label: "draft", tone: "muted" });
  }

  if (rateLimited) {
    badges.push({ key: "rate-limited", label: "GitHub details limited", tone: "warning" });
    return badges;
  }

  if (pr.state === "open" && !pr.isDraft) {
    badges.push({
      key: "ci",
      label:
        pr.ciStatus === "failing"
          ? `${pr.ciChecks.filter((check) => check.status === "failed").length || 1} check failing`
          : pr.ciStatus === "pending"
            ? "CI pending"
            : pr.ciStatus === "passing"
              ? "CI passing"
              : "CI unavailable",
      tone:
        pr.ciStatus === "failing"
          ? "danger"
          : pr.ciStatus === "pending"
            ? "warning"
            : pr.ciStatus === "passing"
              ? "success"
              : "neutral",
    });

    badges.push({
      key: "review",
      label:
        pr.reviewDecision === "approved"
          ? "approved"
          : pr.reviewDecision === "changes_requested"
            ? "changes requested"
            : "needs review",
      tone:
        pr.reviewDecision === "approved"
          ? "success"
          : pr.reviewDecision === "changes_requested"
            ? "danger"
            : "warning",
    });
  }

  if (isPRMergeReady(pr)) {
    badges.push({ key: "merge-ready", label: "merge ready", tone: "success" });
  } else if (pr.state === "open") {
    badges.push({
      key: "merge-state",
      label: pr.mergeability.mergeable ? "not ready to merge" : "not mergeable",
      tone: pr.mergeability.mergeable ? "warning" : "muted",
    });
  }

  if (pr.unresolvedThreads > 0) {
    badges.push({
      key: "threads",
      label: `${pr.unresolvedThreads} unresolved thread${pr.unresolvedThreads === 1 ? "" : "s"}`,
      tone: "warning",
    });
  }

  return badges;
}

export function getPRBlockers(pr: DashboardPR): PRBlocker[] {
  const issues: PRBlocker[] = [];

  if (isPRRateLimited(pr)) {
    issues.push({
      icon: "!",
      color: "var(--color-status-attention)",
      text: "GitHub details unavailable due to rate limiting",
    });
    return issues;
  }

  if (pr.ciStatus === CI_STATUS.FAILING) {
    const failCount = pr.ciChecks.filter((check) => check.status === "failed").length;
    issues.push({
      icon: "x",
      color: "var(--color-status-error)",
      text:
        failCount > 0
          ? `CI failing - ${failCount} check${failCount !== 1 ? "s" : ""} failed`
          : "CI failing",
    });
  } else if (pr.ciStatus === CI_STATUS.PENDING) {
    issues.push({
      icon: "o",
      color: "var(--color-status-attention)",
      text: "CI pending",
    });
  }

  if (pr.reviewDecision === "changes_requested") {
    issues.push({
      icon: "x",
      color: "var(--color-status-error)",
      text: "Changes requested",
    });
  } else if (!pr.mergeability.approved && pr.state === "open" && !pr.isDraft) {
    issues.push({
      icon: "o",
      color: "var(--color-text-tertiary)",
      text: "Not approved - awaiting reviewer",
    });
  }

  if (pr.state !== "merged" && !pr.mergeability.noConflicts) {
    issues.push({
      icon: "x",
      color: "var(--color-status-error)",
      text: "Merge conflicts",
    });
  }

  if (!pr.mergeability.mergeable && issues.length === 0) {
    issues.push({
      icon: "o",
      color: "var(--color-text-tertiary)",
      text: "Not mergeable",
    });
  }

  if (pr.unresolvedThreads > 0) {
    issues.push({
      icon: "o",
      color: "var(--color-status-attention)",
      text: `${pr.unresolvedThreads} unresolved comment${pr.unresolvedThreads !== 1 ? "s" : ""}`,
    });
  }

  if (pr.isDraft) {
    issues.push({
      icon: "o",
      color: "var(--color-text-tertiary)",
      text: "Draft PR",
    });
  }

  return issues;
}

function Chip({ chip }: { chip: InspectionLinkChip }) {
  const className = cn(
    "rounded-[4px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:no-underline",
    chip.mono && "font-[var(--font-mono)] text-[10px]",
    chip.tone === "accent" && "text-[var(--color-accent)]",
  );

  if (chip.href) {
    return (
      <a href={chip.href} target="_blank" rel="noopener noreferrer" className={className}>
        {chip.label}
      </a>
    );
  }

  return <span className={className}>{chip.label}</span>;
}

export function SessionInspectionSummary({
  compact = false,
  session,
}: {
  compact?: boolean;
  session: DashboardSession;
}) {
  const activity = getSessionActivity(session);
  const chips = getSessionInspectionChips(session);

  return (
    <section className={compact ? "space-y-3" : "space-y-4"}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2
              className={cn(
                "font-[var(--font-mono)] font-semibold tracking-[-0.01em] text-[var(--color-text-primary)]",
                compact ? "text-[15px]" : "text-[17px]",
              )}
            >
              {session.id}
            </h2>
            <div
              className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5"
              style={{
                background: `color-mix(in srgb, ${activity.color} 12%, transparent)`,
                border: `1px solid color-mix(in srgb, ${activity.color} 20%, transparent)`,
              }}
            >
              <ActivityDot activity={session.activity} dotOnly size={6} />
              <span className="text-[11px] font-semibold" style={{ color: activity.color }}>
                {activity.label}
              </span>
            </div>
          </div>

          {session.summary ? (
            <p
              className={cn(
                "mt-2 leading-relaxed text-[var(--color-text-secondary)]",
                compact ? "text-[12px]" : "text-[13px]",
              )}
            >
              {session.summary}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {chips.map((chip, index) => (
              <div key={chip.key} className="flex items-center gap-1.5">
                {index > 0 ? <span className="text-[var(--color-text-tertiary)]">&middot;</span> : null}
                <Chip chip={chip} />
              </div>
            ))}
          </div>

          <SessionInspectionTimestamps
            createdAt={session.createdAt}
            lastActivityAt={session.lastActivityAt}
            status={session.status}
          />
        </div>
      </div>
    </section>
  );
}

export function SessionInspectionTimestamps({
  createdAt,
  lastActivityAt,
  status,
}: {
  createdAt: string;
  lastActivityAt: string;
  status: string;
}) {
  const [meta, setMeta] = useState<string[]>([]);

  useEffect(() => {
    setMeta([humanizeStatus(status), `created ${relativeTime(createdAt)}`, `active ${relativeTime(lastActivityAt)}`]);
  }, [createdAt, lastActivityAt, status]);

  if (meta.length === 0) return null;

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--color-text-tertiary)]">
      <span className="rounded-[3px] bg-[rgba(255,255,255,0.05)] px-1.5 py-0.5 text-[10px] font-medium">
        {meta[0]}
      </span>
      {meta.slice(1).map((item) => (
        <div key={item} className="contents">
          <span className="opacity-40">&middot;</span>
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}

function ToneBadge({ badge }: { badge: PRStatusBadge }) {
  const toneClassName = {
    danger: "bg-[rgba(248,81,73,0.12)] text-[var(--color-accent-red)]",
    muted: "bg-[rgba(125,133,144,0.08)] text-[var(--color-text-muted)]",
    neutral: "bg-[rgba(148,163,184,0.12)] text-[var(--color-text-secondary)]",
    success: "bg-[rgba(63,185,80,0.1)] text-[var(--color-accent-green)]",
    warning: "bg-[rgba(210,153,34,0.12)] text-[var(--color-accent-yellow)]",
  }[badge.tone];

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${toneClassName}`}>
      {badge.label}
    </span>
  );
}

export function PRInspectionSummary({
  compact = false,
  pr,
}: {
  compact?: boolean;
  pr: DashboardPR;
}) {
  const badges = getPRStatusBadges(pr);
  const blockers = getPRBlockers(pr);
  const failedChecks = pr.ciChecks.filter((check) => check.status === "failed").length;
  const showChecks = pr.ciChecks.length > 0 && !isPRRateLimited(pr);
  const borderColor = isPRMergeReady(pr)
    ? "rgba(63,185,80,0.4)"
    : pr.state === "merged"
      ? "rgba(163,113,247,0.3)"
      : "var(--color-border-default)";

  return (
    <section className="overflow-hidden rounded-[8px] border" style={{ borderColor }}>
      <div className={cn("border-b border-[var(--color-border-subtle)]", compact ? "px-4 py-3" : "px-5 py-3.5")}>
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] font-semibold text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-accent)] hover:no-underline"
        >
          PR #{pr.number}: {pr.title}
        </a>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {badges.map((badge) => (
            <ToneBadge key={badge.key} badge={badge} />
          ))}
        </div>
      </div>

      <div className={compact ? "px-4 py-3.5" : "px-5 py-4"}>
        {isPRMergeReady(pr) ? (
          <div className="flex items-center gap-2 rounded-[5px] border border-[rgba(63,185,80,0.25)] bg-[rgba(63,185,80,0.07)] px-3.5 py-2.5">
            <span className="text-[var(--color-status-ready)]">✓</span>
            <span className="text-[13px] font-semibold text-[var(--color-status-ready)]">Ready to merge</span>
          </div>
        ) : blockers.length > 0 ? (
          <div className="space-y-1.5">
            <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              Blockers
            </h4>
            {blockers.map((blocker) => (
              <div key={blocker.text} className="flex items-center gap-2.5 text-[12px]">
                <span className="w-3 shrink-0 text-center text-[11px]" style={{ color: blocker.color }}>
                  {blocker.icon}
                </span>
                <span className="text-[var(--color-text-secondary)]">{blocker.text}</span>
              </div>
            ))}
          </div>
        ) : null}

        {showChecks ? (
          <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h4 className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                CI checks
              </h4>
              {pr.ciStatus === "failing" ? (
                <span className="text-[11px] text-[var(--color-text-muted)]">{failedChecks} failing</span>
              ) : null}
            </div>
            <CICheckList checks={pr.ciChecks} layout={failedChecks > 0 ? "expanded" : "inline"} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
