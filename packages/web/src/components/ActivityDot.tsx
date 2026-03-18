"use client";

import { cn } from "@/lib/cn";

const activityConfig: Record<
  string,
  { label: string; dot: string; bg: string; text: string }
> = {
  active:        { label: "active",   dot: "var(--color-status-working)",   bg: "var(--color-tint-blue)",    text: "var(--color-status-working)" },
  ready:         { label: "ready",    dot: "var(--color-status-ready)",     bg: "var(--color-tint-green)",   text: "var(--color-status-ready)" },
  idle:          { label: "idle",     dot: "var(--color-status-idle)",      bg: "var(--color-tint-neutral)", text: "var(--color-text-secondary)" },
  waiting_input: { label: "waiting",  dot: "var(--color-status-attention)", bg: "var(--color-tint-yellow)",  text: "var(--color-status-attention)" },
  blocked:       { label: "blocked",  dot: "var(--color-status-error)",     bg: "var(--color-tint-red)",     text: "var(--color-status-error)" },
  exited:        { label: "exited",   dot: "var(--color-status-done)",      bg: "var(--color-tint-neutral)", text: "var(--color-text-muted)" },
};

const fallbackConfig = {
  dot: "var(--color-text-tertiary)",
  bg: "var(--color-tint-neutral)",
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
        className={cn(
          "shrink-0 rounded-full",
          isPulsing && "animate-[activity-pulse_2s_ease-in-out_infinite]",
        )}
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
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          isPulsing && "animate-[activity-pulse_2s_ease-in-out_infinite]",
        )}
        style={{ background: c.dot }}
      />
      <span className="text-[10px] font-medium" style={{ color: c.text }}>
        {c.label}
      </span>
    </span>
  );
}
