"use client";

import { type DashboardPR, isPRRateLimited, isPRUnenriched } from "@/lib/types";
import { CIBadge } from "./CIBadge";

export function getSizeLabel(additions: number, deletions: number): string {
  const size = additions + deletions;
  return size > 1000 ? "XL" : size > 500 ? "L" : size > 200 ? "M" : size > 50 ? "S" : "XS";
}

interface PRStatusProps {
  pr: DashboardPR;
}

export function PRStatus({ pr }: PRStatusProps) {
  const sizeLabel = getSizeLabel(pr.additions, pr.deletions);
  const rateLimited = isPRRateLimited(pr);
  const unenriched = isPRUnenriched(pr);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* PR number */}
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        #{pr.number}
      </a>

      {/* Size — shimmer when unenriched, hide when rate limited */}
      {!rateLimited && (unenriched ? (
        <span className="inline-block h-[14px] w-16 animate-pulse rounded-full bg-[var(--color-bg-subtle)]" />
      ) : (
        <span className="inline-flex items-center rounded-full bg-[rgba(125,133,144,0.08)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
          +{pr.additions} -{pr.deletions} {sizeLabel}
        </span>
      ))}

      {/* Merged badge */}
      {pr.state === "merged" && (
        <span className="inline-flex items-center rounded-full bg-[var(--color-chip-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)]">
          merged
        </span>
      )}

      {/* Draft badge */}
      {pr.isDraft && pr.state === "open" && (
        <span className="inline-flex items-center rounded-full bg-[rgba(125,133,144,0.08)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
          draft
        </span>
      )}

      {/* CI status — shimmer when unenriched */}
      {pr.state === "open" && !pr.isDraft && !rateLimited && (unenriched ? (
        <span className="inline-block h-[14px] w-14 animate-pulse rounded-full bg-[var(--color-bg-subtle)]" />
      ) : (
        <CIBadge status={pr.ciStatus} checks={pr.ciChecks} />
      ))}

      {/* Review decision (only for open PRs with real data) */}
      {pr.state === "open" && pr.reviewDecision === "approved" && !rateLimited && !unenriched && (
        <span className="inline-flex items-center rounded-full bg-[rgba(63,185,80,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-green)]">
          approved
        </span>
      )}
    </div>
  );
}

interface PRTableRowProps {
  pr: DashboardPR;
}

export function PRTableRow({ pr }: PRTableRowProps) {
  const sizeLabel = getSizeLabel(pr.additions, pr.deletions);
  const rateLimited = isPRRateLimited(pr);
  const unenriched = isPRUnenriched(pr);
  const hideData = rateLimited || unenriched;

  const reviewLabel = hideData
    ? "—"
    : pr.isDraft
      ? "draft"
      : pr.reviewDecision === "approved"
        ? "approved"
        : pr.reviewDecision === "changes_requested"
          ? "changes requested"
          : "needs review";

  const reviewClass = hideData
    ? "text-[var(--color-text-tertiary)]"
    : pr.isDraft
      ? "text-[var(--color-text-muted)]"
      : pr.reviewDecision === "approved"
        ? "text-[var(--color-accent-green)]"
        : pr.reviewDecision === "changes_requested"
          ? "text-[var(--color-accent-red)]"
          : "text-[var(--color-accent-yellow)]";

  const shimmer = <span className="inline-block h-3 w-12 animate-pulse rounded bg-[var(--color-bg-subtle)]" />;

  return (
    <tr className="border-b border-[var(--color-border-muted)] hover:bg-[rgba(88,166,255,0.03)]">
      <td className="px-3 py-2.5 text-sm">
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
          #{pr.number}
        </a>
      </td>
      <td className="max-w-[420px] truncate px-3 py-2.5 text-sm font-medium">{pr.title}</td>
      <td className="px-3 py-2.5 text-sm">
        {unenriched ? shimmer : rateLimited ? (
          <span className="text-[var(--color-text-tertiary)]">—</span>
        ) : (
          <>
            <span className="text-[var(--color-accent-green)]">+{pr.additions}</span>{" "}
            <span className="text-[var(--color-accent-red)]">-{pr.deletions}</span>{" "}
            <span className="text-[var(--color-text-muted)]">{sizeLabel}</span>
          </>
        )}
      </td>
      <td className="px-3 py-2.5">
        {unenriched ? shimmer : rateLimited ? (
          <span className="text-[var(--color-text-tertiary)]">—</span>
        ) : (
          <CIBadge status={pr.ciStatus} checks={pr.ciChecks} compact />
        )}
      </td>
      <td className={`px-3 py-2.5 text-xs font-semibold ${reviewClass}`}>
        {unenriched ? shimmer : reviewLabel}
      </td>
      <td
        className={`px-3 py-2.5 text-center text-sm font-bold ${unenriched ? "" : pr.unresolvedThreads > 0 ? "text-[var(--color-accent-red)]" : "text-[var(--color-border-default)]"}`}
      >
        {unenriched ? shimmer : pr.unresolvedThreads}
      </td>
    </tr>
  );
}

export function PRCard({ pr }: PRTableRowProps) {
  const sizeLabel = getSizeLabel(pr.additions, pr.deletions);
  const rateLimited = isPRRateLimited(pr);
  const unenriched = isPRUnenriched(pr);

  const reviewLabel = rateLimited || unenriched
    ? "—"
    : pr.isDraft
      ? "draft"
      : pr.reviewDecision === "approved"
        ? "approved"
        : pr.reviewDecision === "changes_requested"
          ? "changes"
          : "review";

  const ciLabel = rateLimited || unenriched
    ? "—"
    : pr.ciStatus === "passing"
      ? "CI passing"
      : pr.ciStatus === "failing"
        ? "CI failing"
        : "CI pending";

  const shimmer = <span className="inline-block h-3 w-10 animate-pulse rounded bg-[var(--color-bg-subtle)]" />;

  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mobile-pr-card"
    >
      <div className="mobile-pr-card__line">
        <span className="mobile-pr-card__number">#{pr.number}</span>
        <span className="mobile-pr-card__title">{pr.title}</span>
        {!rateLimited && !unenriched ? <span className="mobile-pr-card__size">{sizeLabel}</span> : null}
      </div>
      <div className="mobile-pr-card__meta">
        <span>{unenriched ? shimmer : ciLabel}</span>
        <span>{unenriched ? shimmer : reviewLabel}</span>
        <span>{unenriched ? shimmer : `${pr.unresolvedThreads} threads`}</span>
      </div>
    </a>
  );
}
