"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import {
  type DashboardSession,
  type DashboardPR,
  type AttentionLevel,
  type ActivityState,
  type SessionStatus,
  type SSESnapshotEvent,
  computeStats,
  getAttentionLevel,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { useSSE } from "@/hooks/useSSE";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";

interface DashboardProps {
  sessions: DashboardSession[];
  orchestratorId?: string | null;
  projectName?: string;
}

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
    // Skip SSE overwrite while one or more optimistic updates are in-flight for this session.
    if ((pendingCounts.get(s.id) ?? 0) > 0) return s;
    // Bail out early when this session hasn't actually changed.
    if (s.status === u.status && s.activity === u.activity && s.lastActivityAt === u.lastActivityAt) {
      return s;
    }
    changed = true;
    return {
      ...s,
      status: u.status,
      activity: u.activity,
      lastActivityAt: u.lastActivityAt,
      // Mirror pr.state when the server confirms a merge, so openPRs stats and
      // the PR table stay consistent without waiting for the next full refresh.
      pr: u.status === "merged" && s.pr?.state === "open" ? { ...s.pr, state: "merged" as const } : s.pr,
    };
  });
  // Return original reference when nothing changed so React skips re-render.
  return changed ? next : current;
}

export function Dashboard({ sessions: initialSessions, orchestratorId, projectName }: DashboardProps) {
  const [sessions, setSessions] = useState(initialSessions);

  // Reference-counted map of session IDs with in-flight optimistic updates.
  // Using a count (not a plain Set) so two concurrent actions on the same session
  // don't prematurely lift SSE protection when the first one completes.
  const pendingOptimistic = useRef<Map<string, number>>(new Map());

  const pendingAdd = (id: string) => {
    pendingOptimistic.current.set(id, (pendingOptimistic.current.get(id) ?? 0) + 1);
  };
  const pendingDel = (id: string) => {
    const n = (pendingOptimistic.current.get(id) ?? 1) - 1;
    if (n <= 0) pendingOptimistic.current.delete(id);
    else pendingOptimistic.current.set(id, n);
  };

  // Live stats recomputed from sessions state so they reflect optimistic + SSE updates.
  const stats = useMemo(() => computeStats(sessions), [sessions]);

  // SSE subscription — patch status/activity on every snapshot from /api/events.
  const handleSSEMessage = useCallback(
    (data: SSESnapshotEvent) => {
      if (data.type === "snapshot" && Array.isArray(data.sessions)) {
        setSessions((prev) => applySSESnapshot(prev, data.sessions, pendingOptimistic.current));
      }
    },
    [], // setSessions and pendingOptimistic are stable refs
  );
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
    // Optimistic update — shows PR as merged and marks agent as exited immediately.
    // Setting activity: "exited" keeps computeStats consistent (won't count as working).
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
      // Roll back; SSE will reconcile.
      if (snapshot) {
        setSessions((prev) => prev.map((s) => (s.pr?.number === prNumber ? snapshot : s)));
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

  return (
    <div className="mx-auto max-w-[1100px] px-8 py-8">
      <DynamicFavicon sessions={sessions} projectName={projectName} />
      {/* Header */}
      <div className="mb-7 flex items-baseline justify-between">
        <h1 className="text-[22px] font-semibold tracking-tight">
          <span className="text-[#7c8aff]">Agent</span> Orchestrator
        </h1>
        <div className="flex items-baseline gap-4">
          {orchestratorId && (
            <a
              href={`/sessions/${encodeURIComponent(orchestratorId)}`}
              className="rounded-md border border-[var(--color-border-default)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent-blue)] hover:text-[var(--color-accent-blue)]"
            >
              orchestrator terminal
            </a>
          )}
          <ClientTimestamp />
        </div>
      </div>

      {/* Stats bar */}
      <div className="mb-9 flex gap-8 px-1">
        <Stat value={stats.totalSessions} label="sessions" color="var(--color-accent-blue)" />
        <Stat value={stats.workingSessions} label="working" color="var(--color-accent-green)" />
        <Stat value={stats.openPRs} label="open PRs" color="var(--color-accent-violet)" />
        <Stat value={stats.needsReview} label="need review" color="var(--color-accent-yellow)" />
      </div>

      {/* Attention zones */}
      <div className="mb-9">
        <h2 className="mb-3 px-1 text-[13px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
          Sessions
        </h2>
        {(["merge", "respond", "review", "pending", "working", "done"] as AttentionLevel[]).map(
          (level) => (
            <AttentionZone
              key={level}
              level={level}
              sessions={grouped[level]}
              onSend={handleSend}
              onKill={handleKill}
              onMerge={handleMerge}
              onRestore={handleRestore}
            />
          ),
        )}
      </div>

      {/* PR Table */}
      {openPRs.length > 0 && (
        <div>
          <h2 className="mb-3 px-1 text-[13px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
            Pull Requests
          </h2>
          <div className="overflow-hidden rounded-lg border border-[var(--color-border-default)]">
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

/** Renders timestamp client-side only to avoid hydration mismatch. */
function ClientTimestamp() {
  const [time, setTime] = useState<string>("");
  useEffect(() => {
    setTime(new Date().toLocaleString());
  }, []);
  return <span className="text-xs text-[var(--color-text-muted)]">{time}</span>;
}

function Stat({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[28px] font-bold" style={{ color }}>
        {value}
      </span>
      <span className="text-[13px] text-[var(--color-text-muted)]">{label}</span>
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
