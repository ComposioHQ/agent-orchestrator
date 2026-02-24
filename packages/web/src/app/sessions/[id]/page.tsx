"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { SessionDetail } from "@/components/SessionDetail";
import {
  type DashboardSession,
  type SSESnapshotEvent,
  type AttentionLevel,
  getAttentionLevel,
} from "@/lib/types";
import { activityIcon } from "@/lib/activity-icons";
import { useSSE } from "@/hooks/useSSE";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/** Build a descriptive tab title from session data. */
function buildSessionTitle(session: DashboardSession): string {
  const id = session.id;
  const emoji = session.activity ? (activityIcon[session.activity] ?? "") : "";
  const isOrchestrator = id.endsWith("-orchestrator");

  let detail: string;

  if (isOrchestrator) {
    detail = "Orchestrator Terminal";
  } else if (session.pr) {
    detail = `#${session.pr.number} ${truncate(session.pr.branch, 30)}`;
  } else if (session.branch) {
    detail = truncate(session.branch, 30);
  } else {
    detail = "Session Detail";
  }

  return emoji ? `${emoji} ${id} | ${detail}` : `${id} | ${detail}`;
}

interface ZoneCounts {
  merge: number;
  respond: number;
  review: number;
  pending: number;
  working: number;
  done: number;
}

export default function SessionPage() {
  const params = useParams();
  const id = params.id as string;
  const isOrchestrator = id.endsWith("-orchestrator");

  const [session, setSession] = useState<DashboardSession | null>(null);
  const [_zoneCounts, setZoneCounts] = useState<ZoneCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Update document title based on session data
  useEffect(() => {
    if (session) {
      document.title = buildSessionTitle(session);
    } else {
      document.title = `${id} | Session Detail`;
    }
  }, [session, id]);

  // Fetch full session data (includes enriched PR/CI/review info).
  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        setError("Session not found");
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DashboardSession;
      setSession(data);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch session:", err);
      setError("Failed to load session");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchZoneCounts = useCallback(async () => {
    if (!isOrchestrator) return;
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const body = (await res.json()) as { sessions: DashboardSession[] };
      const sessions = body.sessions ?? [];
      const counts: ZoneCounts = {
        merge: 0,
        respond: 0,
        review: 0,
        pending: 0,
        working: 0,
        done: 0,
      };
      for (const s of sessions) {
        if (!s.id.endsWith("-orchestrator")) {
          counts[getAttentionLevel(s) as AttentionLevel]++;
        }
      }
      setZoneCounts(counts);
    } catch {
      // non-critical — status strip just won't show
    }
  }, [isOrchestrator]);

  // Initial fetch — session first, zone counts after (avoids blocking on slow /api/sessions)
  useEffect(() => {
    fetchSession();
    // Delay zone counts so the heavy /api/sessions call doesn't contend with session load
    const t = setTimeout(fetchZoneCounts, 2000);
    return () => clearTimeout(t);
  }, [fetchSession, fetchZoneCounts]);

  // SSE subscription — patch status/activity immediately for instant feedback.
  const handleSSEMessage = useCallback(
    (data: SSESnapshotEvent) => {
      if (data.type !== "snapshot" || !Array.isArray(data.sessions)) return;
      const update = data.sessions.find((s) => s.id === id);
      if (!update) return;
      setSession((prev) => {
        if (!prev) return prev;
        if (
          prev.status !== update.status ||
          prev.activity !== update.activity ||
          prev.lastActivityAt !== update.lastActivityAt
        ) {
          return {
            ...prev,
            status: update.status,
            activity: update.activity,
            lastActivityAt: update.lastActivityAt,
          };
        }
        return prev;
      });
    },
    [id],
  );
  useSSE<SSESnapshotEvent>("/api/events", handleSSEMessage);

  // Poll every 30s to refresh PR/CI enrichment data.
  useEffect(() => {
    const interval = setInterval(fetchSession, 30_000);
    return () => clearInterval(interval);
  }, [fetchSession, fetchZoneCounts]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-base)]">
        <div className="text-[13px] text-[var(--color-text-tertiary)]">Loading session…</div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg-base)]">
        <div className="text-[13px] text-[var(--color-status-error)]">
          {error ?? "Session not found"}
        </div>
        <a href="/" className="text-[12px] text-[var(--color-accent)] hover:underline">
          ← Back to dashboard
        </a>
      </div>
    );
  }

  return <SessionDetail session={session} />;
}
