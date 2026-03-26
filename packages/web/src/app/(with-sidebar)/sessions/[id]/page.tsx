"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { isOrchestratorSession } from "@composio/ao-core/types";
import { SessionDetail } from "@/components/SessionDetail";
import { type DashboardSession, getAttentionLevel, type AttentionLevel } from "@/lib/types";
import { activityIcon } from "@/lib/activity-icons";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

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

  useEffect(() => {
    if (session) {
      document.title = buildSessionTitle(session);
    } else {
      document.title = `${id} | Session Detail`;
    }
  }, [session, id]);

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

  useEffect(() => {
    void fetchSession();
    const t = setTimeout(() => {
      void fetchZoneCounts();
    }, 2000);
    return () => clearTimeout(t);
  }, [fetchSession, fetchZoneCounts]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchSession();
      void fetchZoneCounts();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSession, fetchZoneCounts]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg-base)]">
        <div className="text-[13px] text-[var(--color-text-tertiary)]">Loading session…</div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-[var(--color-bg-base)]">
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
