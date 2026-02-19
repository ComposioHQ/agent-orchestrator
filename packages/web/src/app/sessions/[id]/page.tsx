"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { SessionDetail } from "@/components/SessionDetail";
import type { DashboardSession, SSESnapshotEvent } from "@/lib/types";
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

export default function SessionPage() {
  const params = useParams();
  const id = params.id as string;

  const [session, setSession] = useState<DashboardSession | null>(null);
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
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
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

  // Initial fetch.
  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

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

  // Fallback poll every 30s to refresh PR/CI data (less frequent since SSE handles status changes).
  useEffect(() => {
    const interval = setInterval(fetchSession, 30_000);
    return () => clearInterval(interval);
  }, [fetchSession]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-[var(--color-text-muted)]">Loading session...</div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-[var(--color-accent-red)]">{error || "Session not found"}</div>
      </div>
    );
  }

  return <SessionDetail session={session} />;
}
