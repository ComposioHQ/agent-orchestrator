"use client";

import { useMemo, useState, useCallback, useRef } from "react";
import {
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type AttentionLevel,
  type ActivityState,
  type SessionStatus,
  type SSESnapshotEvent,
  computeStats,
  getAttentionLevel,
  isPRRateLimited,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { useSSE } from "@/hooks/useSSE";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";

export interface OrchestratorInfo {
  id: string;
  projectId: string;
  projectName: string;
}

interface DashboardProps {
  sessions: DashboardSession[];
  orchestratorId?: string | null;
  projectName?: string;
}

const KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;

/**
 * Apply SSE snapshot partial-updates.
 * Only patches status/activity/lastActivityAt; preserves PR data.
 * Skips sessions in `pendingCounts` to avoid clobbering in-flight optimistic updates.
 * Returns the original array reference when nothing changed so React skips re-render.
 */
function applySSESnapshot(
  current: DashboardSession[],
  updates: SSESnapshotEvent["sessions"],
  pendingCounts: ReadonlyMap<string, number>,
): DashboardSession[] {
  const updateMap = new Map(updates.map((u) => [u.id, u]));
  let changed = false;
  const next = current.map((s) => {
    const u = updateMap.get(s.id);
    if (!u) return s;
    if ((pendingCounts.get(s.id) ?? 0) > 0) return s;
    if (
      s.status === u.status &&
      s.activity === u.activity &&
      s.lastActivityAt === u.lastActivityAt
    ) {
      return s;
    }
    changed = true;
    return {
      ...s,
      status: u.status,
      activity: u.activity,
      lastActivityAt: u.lastActivityAt,
      pr:
        u.status === "merged" && s.pr?.state === "open"
          ? { ...s.pr, state: "merged" as const }
          : s.pr,
    };
  });
  return changed ? next : current;
}

export function Dashboard({
  sessions: initialSessions,
  orchestratorId,
  projectName,
}: DashboardProps) {
  const [sessions, setSessions] = useState(initialSessions);
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);

  const pendingOptimistic = useRef<Map<string, number>>(new Map());

  const pendingAdd = (id: string) => {
    pendingOptimistic.current.set(id, (pendingOptimistic.current.get(id) ?? 0) + 1);
  };
  const pendingDel = (id: string) => {
    const n = (pendingOptimistic.current.get(id) ?? 1) - 1;
    if (n <= 0) pendingOptimistic.current.delete(id);
    else pendingOptimistic.current.set(id, n);
  };

  const stats = useMemo(() => computeStats(sessions), [sessions]);

  const handleSSEMessage = useCallback((data: SSESnapshotEvent) => {
    if (data.type === "snapshot" && Array.isArray(data.sessions)) {
      setSessions((prev) => applySSESnapshot(prev, data.sessions, pendingOptimistic.current));
    }
  }, []);
  useSSE<SSESnapshotEvent>("/api/events", handleSSEMessage);

  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of sessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [sessions]);

  const openPRs = useMemo(() => {
    return sessions
      .filter((s): s is DashboardSession & { pr: DashboardPR } => s.pr?.state === "open")
      .map((s) => s.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [sessions]);

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
    }
  };

  const handleKill = async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    const snapshot = sessions.find((s) => s.id === sessionId);
    // Block SSE from overwriting the optimistic state while the request is in-flight.
    pendingAdd(sessionId);
    // Optimistic update — moves session to "done" zone immediately.
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, status: "terminated" as SessionStatus, activity: "exited" as ActivityState }
          : s,
      ),
    );
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      console.error(`Failed to kill ${sessionId}:`, err);
      // Roll back optimistic update; SSE will reconcile true state.
      if (snapshot) {
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? snapshot : s)));
      }
    } finally {
      pendingDel(sessionId);
    }
  };

  const handleMerge = async (prNumber: number) => {
    if (!confirm(`Merge PR #${prNumber}?`)) return;
    const snapshot = sessions.find((s) => s.pr?.number === prNumber);
    if (snapshot) pendingAdd(snapshot.id);
    setSessions((prev) =>
      prev.map((s) => {
        if (s.pr?.number !== prNumber) return s;
        return {
          ...s,
          status: "merged" as SessionStatus,
          activity: "exited" as ActivityState,
          pr: s.pr ? { ...s.pr, state: "merged" as const } : null,
        };
      }),
    );
    try {
      const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      console.error(`Failed to merge PR #${prNumber}:`, err);
      if (snapshot) {
        setSessions((prev) => prev.map((s) => (s.id === snapshot.id ? snapshot : s)));
      }
    } finally {
      if (snapshot) pendingDel(snapshot.id);
    }
  };

  const handleRestore = async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    const snapshot = sessions.find((s) => s.id === sessionId);
    // Block SSE from overwriting the optimistic state while the request is in-flight.
    pendingAdd(sessionId);
    // Optimistic update — moves session out of "done" zone immediately.
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, status: "working" as SessionStatus, activity: "active" as ActivityState }
          : s,
      ),
    );
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      console.error(`Failed to restore ${sessionId}:`, err);
      // Roll back; SSE will reconcile.
      if (snapshot) {
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? snapshot : s)));
      }
    } finally {
      pendingDel(sessionId);
    }
  };

  const hasKanbanSessions = KANBAN_LEVELS.some((l) => grouped[l].length > 0);

  const anyRateLimited = useMemo(
    () => sessions.some((s) => s.pr && isPRRateLimited(s.pr)),
    [sessions],
  );

  return (
    <div className="px-8 py-7">
      <DynamicFavicon sessions={sessions} projectName={projectName} />
      {/* Header */}
      <div className="mb-8 flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-6">
        <div className="flex items-center gap-6">
          <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-[var(--color-text-primary)]">
            Orchestrator
          </h1>
          <StatusLine stats={stats} />
        </div>
        {orchestratorId && (
          <a
            href={`/sessions/${encodeURIComponent(orchestratorId)}`}
            className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-4 py-2 text-[12px] font-semibold hover:no-underline"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
            orchestrator
            <svg
              className="h-3 w-3 opacity-70"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </a>
        )}
      </div>

      {/* Rate limit notice */}
      {anyRateLimited && !rateLimitDismissed && (
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
            onClick={() => setRateLimitDismissed(true)}
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
      )}

      {/* Kanban columns for active zones */}
      {hasKanbanSessions && (
        <div className="mb-8 flex gap-4 overflow-x-auto pb-2">
          {KANBAN_LEVELS.map((level) =>
            grouped[level].length > 0 ? (
              <div key={level} className="min-w-[200px] flex-1">
                <AttentionZone
                  level={level}
                  sessions={grouped[level]}
                  onSend={handleSend}
                  onKill={handleKill}
                  onMerge={handleMerge}
                  onRestore={handleRestore}
                />
              </div>
            ) : null,
          )}
        </div>
      )}

      {/* Done — full-width grid below Kanban */}
      {grouped.done.length > 0 && (
        <div className="mb-8">
          <AttentionZone
            level="done"
            sessions={grouped.done}
            onSend={handleSend}
            onKill={handleKill}
            onMerge={handleMerge}
            onRestore={handleRestore}
          />
        </div>
      )}

      {/* PR Table */}
      {openPRs.length > 0 && (
        <div className="mx-auto max-w-[900px]">
          <h2 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Pull Requests
          </h2>
          <div className="overflow-hidden rounded-[6px] border border-[var(--color-border-default)]">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-border-muted)]">
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    PR
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Title
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Size
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    CI
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Review
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Unresolved
                  </th>
                </tr>
              </thead>
              <tbody>
                {openPRs.map((pr) => (
                  <PRTableRow key={pr.number} pr={pr} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusLine({ stats }: { stats: DashboardStats }) {
  if (stats.totalSessions === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">no sessions</span>;
  }

  const parts: Array<{ value: number; label: string; color?: string }> = [
    { value: stats.totalSessions, label: "sessions" },
    ...(stats.workingSessions > 0
      ? [{ value: stats.workingSessions, label: "active", color: "var(--color-status-working)" }]
      : []),
    ...(stats.openPRs > 0 ? [{ value: stats.openPRs, label: "PRs" }] : []),
    ...(stats.needsReview > 0
      ? [{ value: stats.needsReview, label: "need review", color: "var(--color-status-attention)" }]
      : []),
  ];

  return (
    <div className="flex items-baseline gap-0.5">
      {parts.map((p, i) => (
        <span key={p.label} className="flex items-baseline">
          {i > 0 && <span className="mx-3 text-[11px] text-[var(--color-border-strong)]">·</span>}
          <span
            className="text-[20px] font-bold tabular-nums tracking-tight"
            style={{ color: p.color ?? "var(--color-text-primary)" }}
          >
            {p.value}
          </span>
          <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{p.label}</span>
        </span>
      ))}
    </div>
  );
}

function mergeScore(
  pr: Pick<DashboardPR, "ciStatus" | "reviewDecision" | "mergeability" | "unresolvedThreads">,
): number {
  let score = 0;
  if (!pr.mergeability.noConflicts) score += 40;
  if (pr.ciStatus === CI_STATUS.FAILING) score += 30;
  else if (pr.ciStatus === CI_STATUS.PENDING) score += 5;
  if (pr.reviewDecision === "changes_requested") score += 20;
  else if (pr.reviewDecision !== "approved") score += 10;
  score += pr.unresolvedThreads * 5;
  return score;
}
