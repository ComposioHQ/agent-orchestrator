"use client";

export type Verdict = "pass" | "hard-fail" | "soft-fail" | "human-review";
export type VerdictNextAction =
  | "finish"
  | "retry-oh"
  | "retry-src"
  | "wait-human"
  | "block";

interface VerdictBadgeProps {
  verdict: Verdict;
  verdictNextAction?: VerdictNextAction | null;
  verdictReason?: string | null;
}

const verdictConfig: Record<
  Verdict,
  { label: string; icon: string; className: string }
> = {
  pass: {
    label: "pass",
    icon: "\u2713",
    className:
      "bg-[rgba(63,185,80,0.1)] text-[var(--color-accent-green)]",
  },
  "hard-fail": {
    label: "hard fail",
    icon: "\u2717",
    className: "bg-[rgba(248,81,73,0.15)] text-[var(--color-accent-red)]",
  },
  "soft-fail": {
    label: "soft fail",
    icon: "\u26A0",
    className:
      "bg-[rgba(210,153,34,0.1)] text-[var(--color-accent-yellow)]",
  },
  "human-review": {
    label: "review",
    icon: "\u25C6",
    className:
      "bg-[rgba(188,76,0,0.1)] text-[var(--color-accent-orange)]",
  },
};

const actionLabels: Record<VerdictNextAction, string> = {
  finish: "finish",
  "retry-oh": "retry orchestrator",
  "retry-src": "retry source",
  "wait-human": "awaiting input",
  block: "blocked",
};

export function VerdictBadge({
  verdict,
  verdictNextAction,
  verdictReason,
}: VerdictBadgeProps) {
  const config = verdictConfig[verdict];
  const tooltip = verdictReason ?? undefined;

  return (
    <span className="inline-flex items-center gap-1.5" title={tooltip}>
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide ${config.className}`}
      >
        <span>{config.icon}</span>
        {config.label}
      </span>
      {verdictNextAction && (
        <span className="inline-flex items-center rounded-full bg-[rgba(125,133,144,0.08)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
          {actionLabels[verdictNextAction]}
        </span>
      )}
    </span>
  );
}
