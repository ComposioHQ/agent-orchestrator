"use client";

import type { DashboardPR } from "@/lib/types";
import { CIBadge } from "./CIBadge";

interface PRStatusProps {
  pr: DashboardPR;
}

export function PRStatus({ pr }: PRStatusProps) {
  const size = pr.additions + pr.deletions;
  const sizeLabel = size > 1000 ? "XL" : size > 500 ? "L" : size > 200 ? "M" : size > 50 ? "S" : "XS";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* PR number */}
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center rounded-full bg-[rgba(88,166,255,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-blue)] hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        #{pr.number}
      </a>

      {/* Size */}
      <span className="inline-flex items-center rounded-full bg-[rgba(125,133,144,0.08)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
        +{pr.additions} -{pr.deletions} {sizeLabel}
      </span>

      {/* Merged badge */}
      {pr.state === "merged" && (
        <span className="inline-flex items-center rounded-full bg-[rgba(163,113,247,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-violet)]">
          merged
        </span>
      )}

      {/* Draft badge */}
      {pr.isDraft && pr.state === "open" && (
        <span className="inline-flex items-center rounded-full bg-[rgba(125,133,144,0.08)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
          draft
        </span>
      )}

      {/* CI status (only for open PRs) */}
      {pr.state === "open" && !pr.isDraft && (
        <CIBadge status={pr.ciStatus} checks={pr.ciChecks} />
      )}

      {/* Review decision (only for open PRs) */}
      {pr.state === "open" && pr.reviewDecision === "approved" && (
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
  const size = pr.additions + pr.deletions;
  const sizeLabel = size > 1000 ? "XL" : size > 500 ? "L" : size > 200 ? "M" : size > 50 ? "S" : "XS";

  const reviewLabel = pr.reviewDecision === "approved"
    ? "approved"
    : pr.reviewDecision === "changes_requested"
      ? "changes requested"
      : "needs review";

  const reviewClass = pr.reviewDecision === "approved"
    ? "text-[var(--color-accent-green)]"
    : pr.reviewDecision === "changes_requested"
      ? "text-[var(--color-accent-red)]"
      : "text-[var(--color-accent-yellow)]";

  return (
    <tr className="border-b border-[var(--color-border-muted)] hover:bg-[rgba(88,166,255,0.03)]">
      <td className="px-3 py-2.5 text-sm">
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
          #{pr.number}
        </a>
      </td>
      <td className="max-w-[420px] truncate px-3 py-2.5 text-sm font-medium">
        {pr.title}
      </td>
      <td className="px-3 py-2.5 text-sm">
        <span className="text-[var(--color-accent-green)]">+{pr.additions}</span>{" "}
        <span className="text-[var(--color-accent-red)]">-{pr.deletions}</span>{" "}
        <span className="text-[var(--color-text-muted)]">{sizeLabel}</span>
      </td>
      <td className="px-3 py-2.5">
        <CIBadge status={pr.ciStatus} checks={pr.ciChecks} compact />
      </td>
      <td className={`px-3 py-2.5 text-xs font-semibold ${reviewClass}`}>
        {reviewLabel}
      </td>
      <td className={`px-3 py-2.5 text-center text-sm font-bold ${pr.unresolvedThreads > 0 ? "text-[var(--color-accent-red)]" : "text-[var(--color-border-default)]"}`}>
        {pr.unresolvedThreads}
      </td>
    </tr>
  );
}
