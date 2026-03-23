"use client";

import { cn } from "@/lib/cn";
import { getAccentColor, getStatusDotClass, getStatusText, getStatusTextColor, type TerminalStatus, type TerminalVariant } from "./TerminalTheme";

interface TerminalChromeBarProps {
  sessionId: string;
  variant: TerminalVariant;
  status: TerminalStatus;
  error: string | null;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  isOpenCodeSession: boolean;
  reloading: boolean;
  reloadError: string | null;
  onReload: () => void;
}

export function TerminalChromeBar({
  sessionId,
  variant,
  status,
  error,
  fullscreen,
  onToggleFullscreen,
  isOpenCodeSession,
  reloading,
  reloadError,
  onReload,
}: TerminalChromeBarProps) {
  const accentColor = getAccentColor(variant);
  const statusDotClass = getStatusDotClass(status);
  const statusTextColor = getStatusTextColor(status);
  const statusText = getStatusText(status, error);

  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <div className={cn("h-2 w-2 shrink-0 rounded-full", statusDotClass)} />
      <span className="font-[var(--font-mono)] text-[11px]" style={{ color: accentColor }}>
        {sessionId}
      </span>
      <span
        className={cn("text-[10px] font-medium uppercase tracking-[0.06em]", statusTextColor)}
      >
        {statusText}
      </span>
      {/* XDA clipboard badge */}
      <span
        className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]"
        style={{
          color: accentColor,
          background: `color-mix(in srgb, ${accentColor} 12%, transparent)`,
        }}
      >
        XDA
      </span>
      {isOpenCodeSession ? (
        <button
          onClick={onReload}
          disabled={reloading || status !== "connected"}
          title="Restart OpenCode session (/exit then resume mapped session)"
          aria-label="Restart OpenCode session"
          className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {reloading ? (
            <>
              <svg
                className="h-3 w-3 animate-spin"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M12 3a9 9 0 109 9" />
              </svg>
              restarting
            </>
          ) : (
            <>
              <svg
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M21 12a9 9 0 11-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              restart
            </>
          )}
        </button>
      ) : null}
      {reloadError ? (
        <span
          className="max-w-[40ch] truncate text-[10px] font-medium text-[var(--color-status-error)]"
          title={reloadError}
        >
          {reloadError}
        </span>
      ) : null}
      <button
        onClick={onToggleFullscreen}
        className={cn(
          "flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]",
          !isOpenCodeSession && "ml-auto",
        )}
      >
        {fullscreen ? (
          <>
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
            </svg>
            exit fullscreen
          </>
        ) : (
          <>
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
            </svg>
            fullscreen
          </>
        )}
      </button>
    </div>
  );
}
