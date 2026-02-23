"use client";

import type { CIStatus, DashboardCICheck } from "@/lib/types";

interface CIBadgeProps {
  status: CIStatus;
  checks?: DashboardCICheck[];
  compact?: boolean;
}

const statusConfig: Record<CIStatus, { label: string; className: string; icon: string }> = {
  passing: {
    label: "CI passing",
    className: "bg-[rgba(63,185,80,0.1)] text-[var(--color-accent-green)]",
    icon: "\u2713",
  },
  failing: {
    label: "CI failing",
    className: "bg-[rgba(248,81,73,0.15)] text-[var(--color-accent-red)]",
    icon: "\u2717",
  },
  pending: {
    label: "CI pending",
    className: "bg-[rgba(210,153,34,0.1)] text-[var(--color-accent-yellow)]",
    icon: "\u25CF",
  },
  none: {
    label: "\u2014",
    className: "text-[var(--color-text-muted)]",
    icon: "",
  },
};

export function CIBadge({ status, checks, compact }: CIBadgeProps) {
  const config = statusConfig[status];
  const failedCount = checks?.filter((c) => c.status === "failed").length ?? 0;

  if (status === "none") {
    return <span className="text-xs text-[var(--color-text-muted)]">&mdash;</span>;
  }

  const label =
    status === "failing" && failedCount > 0
      ? `${failedCount} check${failedCount > 1 ? "s" : ""} failing`
      : config.label;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide ${config.className}`}
    >
      {!compact && <span>{config.icon}</span>}
      {label}
    </span>
  );
}

interface CICheckListProps {
  checks: DashboardCICheck[];
  /** "vertical" (default): stacked list. "inline": horizontal wrap. "expanded": stacked with linked names. */
  layout?: "vertical" | "inline" | "expanded";
}

export const checkStatusIcon: Record<DashboardCICheck["status"], { icon: string; color: string }> =
  {
    passed: { icon: "\u2713", color: "var(--color-accent-green)" },
    failed: { icon: "\u2717", color: "var(--color-accent-red)" },
    running: { icon: "\u25CF", color: "var(--color-accent-yellow)" },
    pending: { icon: "\u25CB", color: "var(--color-text-muted)" },
    skipped: { icon: "\u25CB", color: "var(--color-text-muted)" },
  };

/** Sort order for CI checks: failures first, then running, pending, passed, skipped. */
export const ciCheckSortOrder: Record<DashboardCICheck["status"], number> = {
  failed: 0,
  running: 1,
  pending: 2,
  passed: 3,
  skipped: 4,
};

export function CICheckList({ checks, layout = "vertical" }: CICheckListProps) {
  const sorted = [...checks].sort(
    (a, b) => ciCheckSortOrder[a.status] - ciCheckSortOrder[b.status],
  );

  if (layout === "inline") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {sorted.map((check, i) => {
          const { icon, color } = checkStatusIcon[check.status];
          const inner = (
            <span className="inline-flex items-center gap-1 text-xs">
              <span style={{ color }}>{icon}</span>
              <span className="text-[var(--color-text-secondary)]">{check.name}</span>
            </span>
          );
          return check.url ? (
            <a
              key={`${check.name}-${i}`}
              href={check.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:no-underline"
            >
              {inner}
            </a>
          ) : (
            <span key={`${check.name}-${i}`}>{inner}</span>
          );
        })}
      </div>
    );
  }

  if (layout === "expanded") {
    return (
      <div className="space-y-1">
        {sorted.map((check, i) => {
          const { icon, color } = checkStatusIcon[check.status];
          const inner = (
            <span className="inline-flex items-center gap-1 text-xs">
              <span style={{ color }}>{icon}</span>
              <span className="text-[var(--color-text-secondary)]">{check.name}</span>
            </span>
          );
          return (
            <div key={`${check.name}-${i}`} className="flex items-center gap-2">
              {check.url ? (
                <a
                  href={check.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:no-underline"
                >
                  {inner}
                </a>
              ) : (
                inner
              )}
              {check.url && (
                <a
                  href={check.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-[var(--color-accent-blue)] hover:underline"
                >
                  view
                </a>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {sorted.map((check, i) => {
        const { icon, color } = checkStatusIcon[check.status];
        return (
          <div key={`${check.name}-${i}`} className="flex items-center gap-2 text-xs">
            <span style={{ color }} className="w-3.5 shrink-0 text-center">
              {icon}
            </span>
            <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">
              {check.name}
            </span>
            {check.url && (
              <a
                href={check.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-[11px] text-[var(--color-accent-blue)] hover:underline"
              >
                view
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
