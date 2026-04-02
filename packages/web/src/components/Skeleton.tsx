// ── Terminal Loading Skeleton ─────────────────────────────────────────

export function TerminalSkeleton() {
  return (
    <div className="flex h-full w-full flex-col bg-[#0a0a0f] p-4 font-mono text-sm">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="h-3 w-16 animate-pulse rounded bg-[var(--color-accent)]/20" />
          <div className="h-3 w-48 animate-pulse rounded bg-white/5" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-16 animate-pulse rounded bg-[var(--color-accent)]/20" style={{ animationDelay: "150ms" }} />
          <div className="h-3 w-64 animate-pulse rounded bg-white/5" style={{ animationDelay: "150ms" }} />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-16 animate-pulse rounded bg-[var(--color-accent)]/20" style={{ animationDelay: "300ms" }} />
          <div className="h-3 w-36 animate-pulse rounded bg-white/5" style={{ animationDelay: "300ms" }} />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-16 animate-pulse rounded bg-[var(--color-accent)]/20" style={{ animationDelay: "450ms" }} />
          <div className="h-4 w-2 animate-[pulse_1s_ease-in-out_infinite] bg-[var(--color-accent)]/60" />
        </div>
      </div>
    </div>
  );
}

// ── State UI ──────────────────────────────────────────────────────────

interface EmptyStateProps {
  message?: string;
}

export function EmptyState({
  message,
}: EmptyStateProps) {
  const isDefault = !message;
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      {/* Terminal icon */}
      <svg
        className="mb-4 h-8 w-8 text-[var(--color-border-strong)]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        viewBox="0 0 24 24"
      >
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 9l4 3-4 3M13 15h5" />
      </svg>
      <p className="text-[13px] text-[var(--color-text-muted)]">
        {isDefault ? (
          <>
            No sessions running. Start one with{" "}
            <code className="font-[var(--font-mono)] text-[var(--color-text-secondary)]">
              ao start
            </code>
          </>
        ) : (
          message
        )}
      </p>
    </div>
  );
}
