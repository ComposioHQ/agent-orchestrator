export function RateLimitBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="mb-6 flex items-center gap-2.5 rounded border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
      <svg
        className="h-3.5 w-3.5 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <span className="flex-1">
        GitHub API rate limited — PR data (CI status, review state, sizes) may be stale. Will
        retry automatically on next refresh.
      </span>
      <button
        onClick={onDismiss}
        className="ml-1 shrink-0 opacity-60 hover:opacity-100"
        aria-label="Dismiss"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
