"use client";

interface TerminalProps {
  sessionId: string;
}

/**
 * Terminal embed placeholder.
 * Future: integrate xterm.js via the terminal-web plugin.
 */
export function Terminal({ sessionId }: TerminalProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-black">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-[#f85149]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#d29922]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#3fb950]" />
        </div>
        <span className="font-[var(--font-mono)] text-xs text-[var(--color-text-muted)]">
          {sessionId}
        </span>
      </div>
      <div className="flex h-64 items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-[var(--color-text-muted)]">Terminal embed</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            xterm.js integration coming soon
          </p>
        </div>
      </div>
    </div>
  );
}
