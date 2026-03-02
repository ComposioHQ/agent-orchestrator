"use client";

import { useState, useEffect, useCallback } from "react";
import { type DashboardSession, type AttentionLevel, getAttentionLevel } from "@/lib/types";
import { ActivityDot } from "./ActivityDot";
import { cn } from "@/lib/cn";

interface ProxyDashProps {
  initialSessions: DashboardSession[];
  projectName: string;
}

const URGENCY_ORDER: AttentionLevel[] = ["merge", "respond", "review", "pending", "working", "done"];

const zoneStyle: Record<AttentionLevel, { label: string; color: string }> = {
  merge:   { label: "Merge",   color: "var(--color-status-ready)" },
  respond: { label: "Respond", color: "var(--color-status-error)" },
  review:  { label: "Review",  color: "var(--color-accent-orange)" },
  pending: { label: "Pending", color: "var(--color-status-attention)" },
  working: { label: "Working", color: "var(--color-status-working)" },
  done:    { label: "Done",    color: "var(--color-text-tertiary)" },
};

function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!iso || isNaN(ms)) return "—";
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function sortByUrgency(sessions: DashboardSession[]): DashboardSession[] {
  return [...sessions].sort((a, b) => {
    const ai = URGENCY_ORDER.indexOf(getAttentionLevel(a));
    const bi = URGENCY_ORDER.indexOf(getAttentionLevel(b));
    if (ai !== bi) return ai - bi;
    // Secondary: most recent activity first
    return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
  });
}

function mostUrgentSession(sessions: DashboardSession[]): DashboardSession | null {
  const sorted = sortByUrgency(sessions.filter((s) => getAttentionLevel(s) !== "done"));
  return sorted[0] ?? null;
}

interface SessionRowProps {
  session: DashboardSession;
  isTop: boolean;
}

function SessionRow({ session, isTop }: SessionRowProps) {
  const level = getAttentionLevel(session);
  const { color } = zoneStyle[level];

  return (
    <a
      href={`/sessions/${encodeURIComponent(session.id)}`}
      className={cn(
        "group flex items-center gap-3 rounded-[6px] px-3 py-2.5 text-[12px] transition-colors hover:no-underline",
        isTop
          ? "border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)]"
          : "hover:bg-[var(--color-bg-subtle)]",
      )}
    >
      {/* Urgency indicator */}
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: color }}
      />

      {/* Session ID */}
      <span className="w-[80px] shrink-0 truncate font-mono text-[11px] text-[var(--color-text-secondary)]">
        {session.id}
      </span>

      {/* Issue label */}
      <span className="w-[70px] shrink-0 truncate text-[var(--color-text-muted)]">
        {session.issueLabel ?? "—"}
      </span>

      {/* Branch */}
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-text-secondary)]">
        {session.branch ?? "—"}
      </span>

      {/* Summary (if available and not fallback) */}
      {session.summary && !session.summaryIsFallback && (
        <span className="hidden min-w-0 max-w-[200px] truncate text-[11px] text-[var(--color-text-muted)] md:block">
          {session.summary}
        </span>
      )}

      {/* PR link */}
      {session.pr ? (
        <a
          href={session.pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[var(--color-accent)] hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          #{session.pr.number}
        </a>
      ) : (
        <span className="w-[30px] shrink-0 text-center text-[var(--color-text-tertiary)]">—</span>
      )}

      {/* Activity */}
      <span className="shrink-0">
        <ActivityDot activity={session.activity} dotOnly />
      </span>

      {/* Time since last activity */}
      <span className="w-[28px] shrink-0 text-right text-[10px] text-[var(--color-text-tertiary)]">
        {relativeTime(session.lastActivityAt)}
      </span>

      {/* Arrow */}
      <svg
        className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)] transition-colors group-hover:text-[var(--color-accent)]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <path d="M9 18l6-6-6-6" />
      </svg>
    </a>
  );
}

export function ProxyDash({ initialSessions, projectName }: ProxyDashProps) {
  const [sessions, setSessions] = useState<DashboardSession[]>(initialSessions);
  const [lastRefresh, setLastRefresh] = useState(Date.now());
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const body = (await res.json()) as { sessions: DashboardSession[] };
      const all = body.sessions ?? [];
      setSessions(all.filter((s) => !s.id.endsWith("-orchestrator")));
      setLastRefresh(Date.now());
    } catch {
      // Ignore transient errors — stale data is fine
    }
  }, []);

  // Poll every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      refresh();
      setTick((t) => t + 1);
    }, 5_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Tick every second to update relative times
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(interval);
  }, []);

  const sorted = sortByUrgency(sessions);
  const topSession = mostUrgentSession(sessions);
  const activeSessions = sorted.filter((s) => getAttentionLevel(s) !== "done");
  const doneSessions = sorted.filter((s) => getAttentionLevel(s) === "done");
  const secondsAgo = Math.floor((Date.now() - lastRefresh) / 1000);

  return (
    <div className="min-h-screen bg-[var(--color-bg-base)] px-6 py-5">
      {/* Header */}
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a
            href="/"
            className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          >
            ← {projectName}
          </a>
          <span className="text-[var(--color-border-default)]">/</span>
          <h1 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
            proxydash
          </h1>
        </div>
        <span className="text-[10px] text-[var(--color-text-tertiary)]">
          {tick > 0 && secondsAgo < 5 ? "refreshed just now" : `${secondsAgo}s ago`}
        </span>
      </div>

      {/* Jump to most urgent */}
      {topSession && (
        <div className="mb-5">
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Most Urgent
          </div>
          <SessionRow session={topSession} isTop />
        </div>
      )}

      {/* Active sessions */}
      {activeSessions.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Active · {activeSessions.length}
          </div>
          <div className="flex flex-col gap-0.5">
            {activeSessions.map((session) => (
              <SessionRow key={session.id} session={session} isTop={false} />
            ))}
          </div>
        </div>
      )}

      {/* Done sessions (collapsed by default via scrolling) */}
      {doneSessions.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Done · {doneSessions.length}
          </div>
          <div className="flex flex-col gap-0.5 opacity-50">
            {doneSessions.map((session) => (
              <SessionRow key={session.id} session={session} isTop={false} />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {sessions.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-[13px] text-[var(--color-text-muted)]">No sessions found</p>
          <a
            href="/"
            className="mt-2 text-[12px] text-[var(--color-accent)] hover:underline"
          >
            Go to dashboard
          </a>
        </div>
      )}

      {/* Column header */}
      {sessions.length > 0 && (
        <div className="mt-6 flex items-center gap-3 border-t border-[var(--color-border-subtle)] px-3 pt-3 text-[10px] text-[var(--color-text-tertiary)]">
          <span className="w-2 shrink-0" />
          <span className="w-[80px] shrink-0">session</span>
          <span className="w-[70px] shrink-0">issue</span>
          <span className="flex-1">branch</span>
          <span className="w-[30px] shrink-0 text-center">pr</span>
          <span className="shrink-0">activity</span>
          <span className="w-[28px] shrink-0 text-right">age</span>
          <span className="w-3.5 shrink-0" />
        </div>
      )}
    </div>
  );
}
