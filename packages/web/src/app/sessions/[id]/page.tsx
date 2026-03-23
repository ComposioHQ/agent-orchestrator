"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { isOrchestratorSession } from "@composio/ao-core/types";
import { SessionDetail } from "@/components/SessionDetail";
import { type DashboardSession, getAttentionLevel, type AttentionLevel } from "@/lib/types";
import { activityIcon } from "@/lib/activity-icons";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/** Build a descriptive tab title from session data. */
function buildSessionTitle(session: DashboardSession): string {
  const id = session.id;
  const emoji = session.activity ? (activityIcon[session.activity] ?? "") : "";
  const isOrchestrator = isOrchestratorSession(session);

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

  const [session, setSession] = useState<DashboardSession | null>(null);
  const [zoneCounts, setZoneCounts] = useState<ZoneCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionProjectId = session?.projectId ?? null;
  const sessionIsOrchestrator = session ? isOrchestratorSession(session) : false;

  // Update document title when session data loads (initial title set by layout.tsx metadata)
  useEffect(() => {
    if (session) document.title = buildSessionTitle(session);
  }, [session]);

  // Fetch session data (memoized to avoid recreating on every render)
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
    if (!sessionIsOrchestrator || !sessionProjectId) return;
    try {
      const res = await fetch(`/api/sessions?project=${encodeURIComponent(sessionProjectId)}`);
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
        if (!isOrchestratorSession(s)) {
          counts[getAttentionLevel(s) as AttentionLevel]++;
        }
      }
      setZoneCounts(counts);
    } catch {
      // non-critical - status strip just won't show
    }
  }, [sessionIsOrchestrator, sessionProjectId]);

  // Initial fetch — session first, zone counts after (avoids blocking on slow /api/sessions)
  useEffect(() => {
    fetchSession();
    // Delay zone counts so the heavy /api/sessions call doesn't contend with session load
    const t = setTimeout(fetchZoneCounts, 2000);
    return () => clearTimeout(t);
  }, [fetchSession, fetchZoneCounts]);

  // Keep refs to latest callbacks so the SSE effect doesn't re-run when they change
  const fetchSessionRef = useRef(fetchSession);
  const fetchZoneCountsRef = useRef(fetchZoneCounts);
  useEffect(() => { fetchSessionRef.current = fetchSession; }, [fetchSession]);
  useEffect(() => { fetchZoneCountsRef.current = fetchZoneCounts; }, [fetchZoneCounts]);

  // Real-time updates via SSE — stable effect that only reconnects when id changes
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string; sessions?: Array<{ id: string; status: string; activity: string | null; lastActivityAt: string }> };
        if (data.type === "snapshot" && data.sessions) {
          const patch = data.sessions.find((s) => s.id === id);
          if (patch) {
            setSession((prev) => {
              if (!prev) return prev;
              if (prev.status === patch.status && prev.activity === patch.activity && prev.lastActivityAt === patch.lastActivityAt) return prev;
              return { ...prev, status: patch.status as DashboardSession["status"], activity: patch.activity as DashboardSession["activity"], lastActivityAt: patch.lastActivityAt };
            });
          }
        }
      } catch { /* ignore parse errors */ }
    };
    es.onerror = () => undefined;
    // Full refetch every 15s as fallback for enriched data (PR state, etc.)
    const fallback = setInterval(() => { fetchSessionRef.current(); fetchZoneCountsRef.current(); }, 15_000);
    return () => { es.close(); clearInterval(fallback); };
  }, [id]);

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

  return (
    <SessionDetail
      session={session}
      isOrchestrator={sessionIsOrchestrator}
      orchestratorZones={zoneCounts ?? undefined}
    />
  );
}
