"use client";

import { useState, useEffect, useCallback } from "react";

interface LogEntry {
  ts: string;
  level: "stdout" | "stderr" | "info" | "warn" | "error";
  source: "dashboard" | "lifecycle" | "cli" | "api" | "browser";
  sessionId: string | null;
  message: string;
  data?: Record<string, unknown>;
}

const LEVEL_COLORS: Record<string, string> = {
  error: "text-red-400",
  warn: "text-yellow-400",
  stderr: "text-red-300",
  stdout: "text-[var(--color-text-secondary)]",
  info: "text-blue-400",
};

const SOURCE_OPTIONS = ["events", "dashboard", "api", "browser"] as const;
const LEVEL_OPTIONS = ["stdout", "stderr", "info", "warn", "error"] as const;

export function LogViewer() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<string>("events");
  const [level, setLevel] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ source, limit: "200" });
      if (level) params.set("level", level);
      if (sessionId) params.set("sessionId", sessionId);

      const res = await fetch(`/api/logs?${params}`);
      if (!res.ok) return;
      const data = (await res.json()) as { entries: LogEntry[] };
      setEntries(data.entries);
    } catch {
      // Transient error — skip
    } finally {
      setLoading(false);
    }
  }, [source, level, sessionId]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => void fetchLogs(), 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  return (
    <div>
      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
        >
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
        >
          <option value="">all levels</option>
          {LEVEL_OPTIONS.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>

        <input
          type="text"
          placeholder="session ID"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]"
        />

        <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          auto-refresh
        </label>
      </div>

      {/* Log table */}
      <div className="overflow-hidden rounded-lg border border-[var(--color-border-default)]">
        <table className="w-full border-collapse font-mono text-xs">
          <thead>
            <tr className="border-b border-[var(--color-border-muted)] bg-[var(--color-bg-secondary)]">
              <th className="px-2 py-1.5 text-left font-semibold text-[var(--color-text-muted)]">Time</th>
              <th className="px-2 py-1.5 text-left font-semibold text-[var(--color-text-muted)]">Level</th>
              <th className="px-2 py-1.5 text-left font-semibold text-[var(--color-text-muted)]">Session</th>
              <th className="px-2 py-1.5 text-left font-semibold text-[var(--color-text-muted)]">Message</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="px-2 py-4 text-center text-[var(--color-text-muted)]">
                  Loading...
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-2 py-4 text-center text-[var(--color-text-muted)]">
                  No log entries found.
                </td>
              </tr>
            ) : (
              entries.map((entry, i) => (
                <tr
                  key={`${entry.ts}-${i}`}
                  className="border-b border-[var(--color-border-muted)] last:border-0 hover:bg-[var(--color-bg-secondary)]"
                >
                  <td className="whitespace-nowrap px-2 py-1 text-[var(--color-text-muted)]">
                    {new Date(entry.ts).toLocaleTimeString()}
                  </td>
                  <td className={`px-2 py-1 ${LEVEL_COLORS[entry.level] ?? ""}`}>
                    {entry.level}
                  </td>
                  <td className="px-2 py-1">
                    {entry.sessionId ? (
                      <a
                        href={`/sessions/${encodeURIComponent(entry.sessionId)}`}
                        className="text-[var(--color-accent-blue)] hover:underline"
                      >
                        {entry.sessionId}
                      </a>
                    ) : (
                      <span className="text-[var(--color-text-muted)]">—</span>
                    )}
                  </td>
                  <td className="max-w-[600px] truncate px-2 py-1 text-[var(--color-text-primary)]">
                    {entry.message}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-2 text-xs text-[var(--color-text-muted)]">
        {entries.length} entries
      </div>
    </div>
  );
}
