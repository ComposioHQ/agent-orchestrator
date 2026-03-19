// ── Skeleton primitives & state UI ────────────────────────────────────

interface SkeletonBlockProps {
  className?: string;
}

export function SkeletonBlock({ className = "" }: SkeletonBlockProps) {
  return (
    <div
      className={`animate-pulse rounded bg-[var(--color-border-subtle)] ${className}`}
    />
  );
}

// ── Empty State ────────────────────────────────────────────────────────

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

// ── Error State ────────────────────────────────────────────────────────

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      {/* Error icon */}
      <svg
        className="mb-4 h-8 w-8 text-[var(--color-status-error)]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M15 9l-6 6M9 9l6 6" />
      </svg>
      <p className="mb-4 text-[13px] text-[var(--color-status-error)]">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="rounded-[6px] border border-[var(--color-border-default)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
        >
          Retry
        </button>
      )}
      <a
        href="/"
        className="mt-3 text-[12px] text-[var(--color-accent)] hover:underline"
      >
        ← Back to dashboard
      </a>
    </div>
  );
}

// ── Dashboard Skeleton ─────────────────────────────────────────────────

export function DashboardSkeleton() {
  return (
    <div className="flex h-screen">
      <div className="flex-1 overflow-y-auto px-8 py-7">
        {/* Header bar */}
        <div className="mb-8 flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-6">
          <div className="flex items-center gap-6">
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-6 w-40" />
          </div>
          <SkeletonBlock className="h-7 w-24 rounded-[7px]" />
        </div>

        {/* Kanban-style card columns */}
        <div className="mb-8 flex gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="min-w-[200px] flex-1 space-y-3">
              <SkeletonBlock className="h-3 w-20" />
              {[1, 2].map((j) => (
                <div
                  key={j}
                  className="rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4 space-y-2"
                >
                  <SkeletonBlock className="h-3 w-3/4" />
                  <SkeletonBlock className="h-3 w-1/2" />
                  <SkeletonBlock className="h-3 w-5/6" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── SessionDetail Skeleton ─────────────────────────────────────────────

export function SessionDetailSkeleton() {
  return (
    <div className="min-h-screen bg-[var(--color-bg-base)]">
      {/* Nav bar */}
      <nav className="nav-glass sticky top-0 z-10 border-b border-[var(--color-border-subtle)]">
        <div className="mx-auto flex max-w-[900px] items-center gap-2 px-8 py-2.5">
          <SkeletonBlock className="h-3 w-20" />
          <span className="text-[var(--color-border-strong)]">/</span>
          <SkeletonBlock className="h-3 w-32" />
        </div>
      </nav>

      <div className="mx-auto max-w-[900px] px-8 py-6">
        {/* Header card */}
        <div className="detail-card mb-6 rounded-[8px] border border-[var(--color-border-default)] p-5">
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <SkeletonBlock className="h-5 w-48" />
              <SkeletonBlock className="h-5 w-20 rounded-full" />
            </div>
            <SkeletonBlock className="h-3 w-3/4" />
            <div className="flex items-center gap-2">
              <SkeletonBlock className="h-4 w-16 rounded-[4px]" />
              <SkeletonBlock className="h-4 w-12 rounded-[4px]" />
              <SkeletonBlock className="h-4 w-24 rounded-[4px]" />
            </div>
            <div className="flex items-center gap-2">
              <SkeletonBlock className="h-3 w-16 rounded-[3px]" />
              <SkeletonBlock className="h-3 w-20" />
            </div>
          </div>
        </div>

        {/* PR card skeleton */}
        <div className="detail-card mb-6 overflow-hidden rounded-[8px] border border-[var(--color-border-default)]">
          <div className="border-b border-[var(--color-border-subtle)] px-5 py-3.5">
            <SkeletonBlock className="h-4 w-2/3" />
            <div className="mt-2 flex gap-2">
              <SkeletonBlock className="h-3 w-16" />
              <SkeletonBlock className="h-3 w-12" />
            </div>
          </div>
          <div className="px-5 py-4 space-y-2">
            <SkeletonBlock className="h-8 w-full rounded-[5px]" />
            <SkeletonBlock className="h-3 w-1/2" />
            <SkeletonBlock className="h-3 w-3/4" />
          </div>
        </div>
      </div>
    </div>
  );
}
