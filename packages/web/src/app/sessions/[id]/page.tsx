"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { isOrchestratorSession } from "@composio/ao-core/types";
import { SessionDetail } from "@/components/SessionDetail";
import { type DashboardSession, type ActivityState, getAttentionLevel, type AttentionLevel } from "@/lib/types";
import { activityIcon } from "@/lib/activity-icons";
import { useSSESessionActivity } from "@/hooks/useSSESessionActivity";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/** Build a descriptive tab title from session data. */
function buildSessionTitle(
  session: DashboardSession,
  activityOverride?: ActivityState | null,
): string {
  const id = session.id;
  const activity = activityOverride !== undefined ? activityOverride : session.activity;
  const emoji = activity ? (activityIcon[activity] ?? "") : "";
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

interface ProjectSessionsBody {
  sessions?: DashboardSession[];
  orchestratorId?: string | null;
  orchestrators?: Array<{ id: string; projectId: string; projectName: string }>;
}

export default function SessionPage() {
  const params = useParams();
  const id = params.id as string;

  const [session, setSession] = useState<DashboardSession | null>(null);
  const [zoneCounts, setZoneCounts] = useState<ZoneCounts | null>(null);
  const [projectOrchestratorId, setProjectOrchestratorId] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionProjectId = session?.projectId ?? null;
  const sessionIsOrchestrator = session ? isOrchestratorSession(session) : false;
  const sessionProjectIdRef = useRef<string | null>(null);
  const sessionIsOrchestratorRef = useRef(false);
  const resolvedProjectSessionsKeyRef = useRef<string | null>(null);

  // Subscribe to SSE for real-time activity updates (title emoji)
  const sseActivity = useSSESessionActivity(id);

  // Update document title based on session data + SSE activity override
  useEffect(() => {
    if (session) {
      document.title = buildSessionTitle(session, sseActivity?.activity);
    } else {
      document.title = `${id} | Session Detail`;
    }
  }, [session, id, sseActivity]);

  useEffect(() => {
    sessionProjectIdRef.current = sessionProjectId;
  }, [sessionProjectId]);

  useEffect(() => {
    sessionIsOrchestratorRef.current = sessionIsOrchestrator;
  }, [sessionIsOrchestrator]);

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

  const fetchProjectSessions = useCallback(async () => {
    const projectId = sessionProjectIdRef.current;
    if (!projectId) return;
    const isOrchestrator = sessionIsOrchestratorRef.current;
    const projectSessionsKey = `${projectId}:${isOrchestrator ? "orchestrator" : "worker"}`;
    if (!isOrchestrator && resolvedProjectSessionsKeyRef.current === projectSessionsKey) return;
    try {
      const query = isOrchestrator
        ? `/api/sessions?project=${encodeURIComponent(projectId)}`
        : `/api/sessions?project=${encodeURIComponent(projectId)}&orchestratorOnly=true`;
      const res = await fetch(query);
      if (!res.ok) return;
      const body = (await res.json()) as ProjectSessionsBody;
      const sessions = body.sessions ?? [];
      const orchestratorId =
        body.orchestratorId ??
        body.orchestrators?.find((orchestrator) => orchestrator.projectId === projectId)?.id ??
        null;
      setProjectOrchestratorId((current) => (current === orchestratorId ? current : orchestratorId));

      if (!isOrchestrator) {
        resolvedProjectSessionsKeyRef.current = projectSessionsKey;
        return;
      }

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
  }, []);

  useEffect(() => {
    if (!sessionIsOrchestrator) {
      setZoneCounts(null);
    }
  }, [sessionIsOrchestrator]);

  // Initial fetch — session first, zone counts after (avoids blocking on slow /api/sessions)
  useEffect(() => {
    fetchSession();
    // Delay zone counts so the heavy /api/sessions call doesn't contend with session load
    const t = setTimeout(fetchProjectSessions, 2000);
    return () => clearTimeout(t);
  }, [fetchSession, fetchProjectSessions]);

  // Poll every 5s
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSession();
      fetchProjectSessions();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSession, fetchProjectSessions]);

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
      projectOrchestratorId={projectOrchestratorId}
    />
  );
}
