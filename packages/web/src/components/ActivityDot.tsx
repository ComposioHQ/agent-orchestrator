"use client";

import { cn } from "@/lib/cn";

const activityConfig: Record<
  string,
  { label: string; dot: string; bg: string; text: string }
> = {
  active:        { label: "active",   dot: "var(--color-status-working)",   bg: "rgba(34,197,94,0.1)",    text: "var(--color-status-working)" },
  ready:         { label: "ready",    dot: "var(--color-status-ready)",     bg: "rgba(91,126,248,0.1)",   text: "var(--color-status-ready)" },
  idle:          { label: "idle",     dot: "var(--color-status-idle)",      bg: "rgba(72,79,88,0.25)",    text: "var(--color-text-secondary)" },
  waiting_input: { label: "waiting",  dot: "var(--color-status-attention)", bg: "rgba(210,153,34,0.12)",  text: "var(--color-status-attention)" },
  blocked:       { label: "blocked",  dot: "var(--color-status-error)",     bg: "rgba(248,81,73,0.1)",    text: "var(--color-status-error)" },
  exited:        { label: "exited",   dot: "var(--color-status-done)",      bg: "rgba(48,54,61,0.5)",     text: "var(--color-text-muted)" },
};

const fallbackConfig = {
  dot: "var(--color-text-tertiary)",
  bg: "rgba(74,74,74,0.2)",
  text: "var(--color-text-muted)",
};

interface ActivityDotProps {
  activity: string | null;
  /** When true renders only the dot (no label pill) — for detail page headers */
  dotOnly?: boolean;
  size?: number;
}

export function ActivityDot({ activity, dotOnly = false, size = 6 }: ActivityDotProps) {
  const c = (activity !== null && activityConfig[activity]) || {
    label: activity ?? "unknown",
    ...fallbackConfig,
  };
  const isPulsing = activity === "active";

  if (dotOnly) {
    return (
      <div
        className={cn("shrink-0 rounded-full", isPulsing && "dot-pulse")}
        style={{ width: size, height: size, background: c.dot }}
      />
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5"
      style={{ background: c.bg }}
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", isPulsing && "dot-pulse")}
        style={{ background: c.dot }}
      />
      <span className="text-[10px] font-medium" style={{ color: c.text }}>
        {c.label}
      </span>
    </span>
  );
}
