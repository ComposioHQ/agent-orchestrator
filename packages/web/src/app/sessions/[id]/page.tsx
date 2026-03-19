"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { isOrchestratorSession } from "@composio/ao-core/types";
import { SessionDetail, SessionDetailSkeleton } from "@/components/SessionDetail";
import { ErrorState } from "@/components/Skeleton";
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

  // Update document title based on session data
  useEffect(() => {
    if (session) {
      document.title = buildSessionTitle(session);
    } else {
      document.title = `${id} | Session Detail`;
    }
  }, [session, id]);

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

  // Poll every 5s
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSession();
      fetchZoneCounts();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSession, fetchZoneCounts]);

  if (loading) {
    return <SessionDetailSkeleton />;
  }

  if (error || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-base)]">
        <ErrorState
          message={error ?? "Session not found"}
          onRetry={error ? fetchSession : undefined}
        />
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
