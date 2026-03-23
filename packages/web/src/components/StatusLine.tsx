import type { DashboardStats } from "@/lib/types";

export function StatusLine({ stats }: { stats: DashboardStats }) {
  if (stats.totalSessions === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">no sessions</span>;
  }

  const parts: Array<{ value: number; label: string; color?: string }> = [
    { value: stats.totalSessions, label: "sessions" },
    ...(stats.workingSessions > 0
      ? [{ value: stats.workingSessions, label: "working", color: "var(--color-status-working)" }]
      : []),
    ...(stats.openPRs > 0 ? [{ value: stats.openPRs, label: "PRs" }] : []),
    ...(stats.needsReview > 0
      ? [{ value: stats.needsReview, label: "need review", color: "var(--color-status-attention)" }]
      : []),
  ];

  return (
    <div className="flex items-baseline gap-0.5">
      {parts.map((part, index) => (
        <span key={part.label} className="flex items-baseline">
          {index > 0 && (
            <span className="mx-3 text-[11px] text-[var(--color-border-strong)]">&middot;</span>
          )}
          <span
            className="text-[20px] font-bold tabular-nums tracking-tight"
            style={{ color: part.color ?? "var(--color-text-primary)" }}
          >
            {part.value}
          </span>
          <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{part.label}</span>
        </span>
      ))}
    </div>
  );
}
