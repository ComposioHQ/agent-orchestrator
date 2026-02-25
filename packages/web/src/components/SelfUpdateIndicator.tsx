"use client";

import { useCallback, useEffect, useState } from "react";

interface Commit {
  hash: string;
  subject: string;
}

interface UpdateCheck {
  available: boolean;
  dirty: boolean;
  behindCount?: number;
  commits?: Commit[];
  currentHead?: string;
  remoteHead?: string;
  error?: string;
}

type Phase = "idle" | "checking" | "ready" | "updating" | "error";

export function SelfUpdateIndicator() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [data, setData] = useState<UpdateCheck | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkForUpdates = useCallback(async () => {
    setPhase("checking");
    setError(null);
    try {
      const res = await fetch("/api/self-update/check");
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Check failed");
        setPhase("error");
        return;
      }
      setData(json);
      setPhase(json.available ? "ready" : "idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setPhase("error");
    }
  }, []);

  // Auto-check on mount and every 5 minutes
  useEffect(() => {
    checkForUpdates();
    const interval = setInterval(checkForUpdates, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [checkForUpdates]);

  const triggerUpdate = async () => {
    if (!confirm("This will stop all agents, pull updates, rebuild, and restart. Continue?")) return;
    setPhase("updating");
    try {
      const res = await fetch("/api/self-update/trigger", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Update failed");
        setPhase("error");
        return;
      }
      // Update started — dashboard will go down shortly
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setPhase("error");
    }
  };

  // Nothing to show when idle and no updates
  if (phase === "idle" && !data?.available) {
    return (
      <button
        onClick={checkForUpdates}
        className="ml-3 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[var(--color-text-muted)] opacity-60 transition-opacity hover:opacity-100"
        title="Check for updates"
      >
        <RefreshIcon className="h-3 w-3" />
      </button>
    );
  }

  if (phase === "checking") {
    return (
      <span className="ml-3 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
        <RefreshIcon className="h-3 w-3 animate-spin" />
        checking…
      </span>
    );
  }

  if (phase === "updating") {
    return (
      <span className="ml-3 flex items-center gap-1.5 text-[11px] text-[var(--color-status-attention)]">
        <RefreshIcon className="h-3 w-3 animate-spin" />
        updating — restarting soon…
      </span>
    );
  }

  if (phase === "error") {
    return (
      <span className="ml-3 flex items-center gap-1.5 text-[11px] text-[var(--color-status-error)]">
        <span>⚠</span>
        <span className="max-w-[200px] truncate">{error}</span>
        <button
          onClick={checkForUpdates}
          className="ml-1 opacity-70 hover:opacity-100"
          title="Retry"
        >
          <RefreshIcon className="h-3 w-3" />
        </button>
      </span>
    );
  }

  // phase === "ready"
  return (
    <div className="relative ml-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="update-badge flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent-green)]"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-green)]" style={{ animation: "pulse 2s infinite" }} />
        {data?.behindCount} update{data?.behindCount !== 1 ? "s" : ""}
        <ChevronIcon className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && data && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[380px] overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] shadow-xl" style={{ animation: "slide-up 0.15s ease" }}>
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
            <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">
              {data.behindCount} pending commit{data.behindCount !== 1 ? "s" : ""}
            </span>
            <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
              {data.currentHead} → {data.remoteHead}
            </span>
          </div>

          {/* Commit list */}
          <div className="max-h-[240px] overflow-y-auto px-2 py-2">
            {data.commits?.map((c) => (
              <div key={c.hash} className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-[var(--color-bg-subtle)]">
                <span className="mt-0.5 shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                  {c.hash.slice(0, 7)}
                </span>
                <span className="text-[11px] leading-snug text-[var(--color-text-primary)]">
                  {c.subject}
                </span>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-4 py-3">
            {data.dirty && (
              <span className="text-[10px] text-[var(--color-status-attention)]">
                ⚠ uncommitted changes
              </span>
            )}
            {!data.dirty && <span />}
            <div className="flex items-center gap-2">
              <button
                onClick={checkForUpdates}
                className="rounded px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-secondary)]"
              >
                Refresh
              </button>
              <button
                onClick={triggerUpdate}
                disabled={data.dirty}
                className="rounded-md bg-[var(--color-accent-green)] px-3 py-1 text-[11px] font-semibold text-[var(--color-text-inverse)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Update & Restart
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
