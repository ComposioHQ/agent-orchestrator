"use client";

import { useAggregatedTerminalConnection } from "@/lib/terminal-connection-store";

/**
 * Fixed top-right indicator that appears whenever any terminal WS or session
 * API request is in a reconnecting state. Disappears as soon as everything
 * is connected. Non-blocking — does not cover any underlying content.
 */
export function ReconnectingPill() {
  const { reconnecting, attempt } = useAggregatedTerminalConnection();
  if (!reconnecting) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-3 bottom-3 z-[200] flex items-center gap-2 rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-accent)] shadow-md"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-accent)] opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-accent)]" />
      </span>
      <span>Reconnecting{attempt > 0 ? ` · attempt ${attempt}` : "…"}</span>
    </div>
  );
}
