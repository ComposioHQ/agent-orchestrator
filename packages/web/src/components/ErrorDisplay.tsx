"use client";

import { useState } from "react";

interface ErrorDisplayProps {
  title: string;
  message: string;
  icon?: "error" | "warning";
  showReset?: boolean;
  onReset?: () => void;
  showReload?: boolean;
  showBackLink?: boolean;
  error?: Error;
}

function ErrorIcon({ variant }: { variant: "error" | "warning" }) {
  if (variant === "error") {
    return (
      <svg
        className="mb-4 h-8 w-8 text-[var(--color-status-error)]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        viewBox="0 0 24 24"
      >
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 9l4 3-4 3M13 15h5" />
        <circle cx="19" cy="7" r="3" fill="var(--color-status-error)" stroke="none" />
      </svg>
    );
  }

  return (
    <svg
      className="mb-4 h-8 w-8 text-[var(--color-status-attention)]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 9l4 3-4 3M13 15h5" />
      <path d="M12 8v3M12 14h.01" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ErrorDisplay({
  title,
  message,
  icon = "error",
  showReset = false,
  onReset,
  showReload = false,
  showBackLink = false,
  error,
}: ErrorDisplayProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center py-24 text-center">
      <ErrorIcon variant={icon} />

      <h2
        className="mb-2 text-[15px] font-medium text-[var(--color-text-primary)]"
        style={{ fontFamily: "var(--font-geist-sans), sans-serif" }}
      >
        {title}
      </h2>

      <p className="mb-6 max-w-sm text-[13px] text-[var(--color-text-muted)]">
        {message}
      </p>

      <div className="flex items-center gap-3">
        {showReset && onReset && (
          <button
            onClick={onReset}
            className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 py-2 text-[13px] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
          >
            Try again
          </button>
        )}
        {showReload && (
          <button
            onClick={() => window.location.reload()}
            className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 py-2 text-[13px] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
          >
            Reload page
          </button>
        )}
        {showBackLink && (
          <a
            href="/"
            className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 py-2 text-[13px] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
          >
            Go to dashboard
          </a>
        )}
      </div>

      {error && (
        <div className="mt-6">
          <button
            onClick={() => setShowDetails((prev) => !prev)}
            className="text-[12px] text-[var(--color-text-muted)] underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--color-text-secondary)]"
          >
            {showDetails ? "Hide" : "Show"} technical details
          </button>
          {showDetails && (
            <pre
              className="mt-3 max-w-lg overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] p-3 text-left text-[11px] text-[var(--color-text-muted)]"
              style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}
            >
              {error.message}
              {"\n\n"}
              {error.stack}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
