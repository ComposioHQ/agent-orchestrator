"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isOrchestratorSession } from "@composio/ao-core/types";
import { SessionDetail } from "@/components/SessionDetail";
import { activityIcon } from "@/lib/activity-icons";
import { getAttentionLevel, type AttentionLevel, type DashboardSession } from "@/lib/types";

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

interface ProjectSessionPageClientProps {
  projectId: string;
  sessionId: string;
}

interface ZoneCounts {
  merge: number;
  respond: number;
  review: number;
  pending: number;
  working: number;
  done: number;
}

export function ProjectSessionPageClient({
  projectId,
  sessionId,
}: ProjectSessionPageClientProps) {
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [zoneCounts, setZoneCounts] = useState<ZoneCounts | null>(null);
  const [projectOrchestratorId, setProjectOrchestratorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionIsOrchestrator = session ? isOrchestratorSession(session) : false;
  const sessionIsOrchestratorRef = useRef(sessionIsOrchestrator);

  useEffect(() => {
    sessionIsOrchestratorRef.current = sessionIsOrchestrator;
  }, [sessionIsOrchestrator]);

  useEffect(() => {
    if (session) {
      document.title = buildSessionTitle(session);
    } else {
      document.title = `${sessionId} | Session Detail`;
    }
  }, [session, sessionId]);

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (res.status === 404) {
        setError("Session not found");
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DashboardSession;
      if (data.projectId !== projectId) {
        setError("Session not found");
        setLoading(false);
        return;
      }
      setSession(data);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch session:", err);
      setError("Failed to load session");
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  const fetchProjectContext = useCallback(async () => {
    try {
      const isOrchestrator = sessionIsOrchestratorRef.current;
      const params = new URLSearchParams({ project: projectId });
      if (!isOrchestrator) {
        params.set("orchestratorOnly", "true");
      }
      const res = await fetch(`/api/sessions?${params.toString()}`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        sessions: DashboardSession[];
        orchestratorId?: string | null;
      };
      setProjectOrchestratorId(body.orchestratorId ?? null);
      if (!isOrchestrator) return;

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
      // non-critical
    }
  }, [projectId]);

  useEffect(() => {
    void fetchSession();
    const t = setTimeout(() => {
      void fetchProjectContext();
    }, 2_000);
    return () => clearTimeout(t);
  }, [fetchProjectContext, fetchSession]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchSession();
      void fetchProjectContext();
    }, 5_000);
    return () => clearInterval(interval);
  }, [fetchProjectContext, fetchSession]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-base)]">
        <div className="text-[13px] text-[var(--color-text-tertiary)]">Loading session...</div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg-base)]">
        <div className="text-[13px] text-[var(--color-status-error)]">
          {error ?? "Session not found"}
        </div>
        <a
          href={`/projects/${encodeURIComponent(projectId)}`}
          className="text-[12px] text-[var(--color-accent)] hover:underline"
        >
          Back to project
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
