"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { notFound, useParams } from "next/navigation";
import { isOrchestratorSession } from "@aoagents/ao-core/types";
import { SessionDetail } from "@/components/SessionDetail";
import { type DashboardSession, type ActivityState, getAttentionLevel, type AttentionLevel } from "@/lib/types";
import { activityIcon } from "@/lib/activity-icons";
import type { ProjectInfo } from "@/lib/project-name";
import { getSessionTitle } from "@/lib/format";
import { useSSESessionActivity } from "@/hooks/useSSESessionActivity";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/** Build a descriptive tab title from session data. */
function buildSessionTitle(
  session: DashboardSession,
  prefixByProject: Map<string, string>,
  activityOverride?: ActivityState | null,
): string {
  const id = session.id;
  const activity = activityOverride !== undefined ? activityOverride : session.activity;
  const emoji = activity ? (activityIcon[activity] ?? "") : "";
  const allPrefixes = [...prefixByProject.values()];
  const isOrchestrator = isOrchestratorSession(session, prefixByProject.get(session.projectId), allPrefixes);

  let detail: string;

  if (isOrchestrator) {
    detail = "Orchestrator Terminal";
  } else {
    detail = truncate(getSessionTitle(session), 40);
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
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sidebarSessions, setSidebarSessions] = useState<DashboardSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [routeError, setRouteError] = useState<Error | null>(null);
  const [sessionMissing, setSessionMissing] = useState(false);
  const [prefixByProject, setPrefixByProject] = useState<Map<string, string>>(new Map());
  const sessionProjectId = session?.projectId ?? null;
  const allPrefixes = [...prefixByProject.values()];
  const sessionIsOrchestrator = session
    ? isOrchestratorSession(session, prefixByProject.get(session.projectId), allPrefixes)
    : false;
  const sessionProjectIdRef = useRef<string | null>(null);
  const sessionIsOrchestratorRef = useRef(false);
  const resolvedProjectSessionsKeyRef = useRef<string | null>(null);
  const prefixByProjectRef = useRef<Map<string, string>>(new Map());
  const hasLoadedSessionRef = useRef(false);

  // Keep prefixByProjectRef in sync so fetchProjectSessions (stable [] dep) reads latest map
  useEffect(() => {
    prefixByProjectRef.current = prefixByProject;
  }, [prefixByProject]);

  // Fetch project prefix map once on mount so isOrchestratorSession can use the correct prefix
  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.ok ? res.json() : null)
      .then((data: { projects?: ProjectInfo[] } | null) => {
        if (data?.projects) {
          setProjects(data.projects);
          setPrefixByProject(
            new Map(data.projects.map((p) => [p.id, p.sessionPrefix ?? p.id])),
          );
        }
      })
      .catch(() => {/* non-critical — falls back to role metadata check */});
  }, []);

  // Subscribe to SSE for real-time activity updates (title emoji)
  const sseActivity = useSSESessionActivity(id);

  // Update document title based on session data + SSE activity override
  useEffect(() => {
    if (session) {
      document.title = buildSessionTitle(session, prefixByProject, sseActivity?.activity);
    } else {
      document.title = `${id} | Session Detail`;
    }
  }, [session, id, prefixByProject, sseActivity]);

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
        if (!hasLoadedSessionRef.current) {
          setSessionMissing(true);
        }
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DashboardSession;
      setSession(data);
      setRouteError(null);
      setSessionMissing(false);
      hasLoadedSessionRef.current = true;
    } catch (err) {
      console.error("Failed to fetch session:", err);
      if (!hasLoadedSessionRef.current) {
        setRouteError(err instanceof Error ? err : new Error("Failed to load session"));
      }
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
      const allPrefixes = [...prefixByProjectRef.current.values()];
      for (const s of sessions) {
        if (!isOrchestratorSession(s, prefixByProjectRef.current.get(s.projectId), allPrefixes)) {
          counts[getAttentionLevel(s) as AttentionLevel]++;
        }
      }
      setZoneCounts(counts);
    } catch {
      // non-critical - status strip just won't show
    }
  }, []);

  const fetchSidebarSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const body = (await res.json()) as { sessions?: DashboardSession[] } | null;
      setSidebarSessions(body?.sessions ?? []);
    } catch {
      // non-critical
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
    fetchSidebarSessions();
    // Delay zone counts so the heavy /api/sessions call doesn't contend with session load
    const t = setTimeout(fetchProjectSessions, 2000);
    return () => clearTimeout(t);
  }, [fetchSession, fetchProjectSessions, fetchSidebarSessions]);

  // Poll every 5s
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSession();
      fetchProjectSessions();
      fetchSidebarSessions();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSession, fetchProjectSessions, fetchSidebarSessions]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-base)]">
        <div className="text-[13px] text-[var(--color-text-tertiary)]">Loading session…</div>
      </div>
    );
  }

  if (sessionMissing) {
    notFound();
    return null;
  }

  if (routeError) {
    throw routeError;
  }

  if (!session) {
    throw new Error("Session data was unavailable after loading completed");
  }

  return (
    <SessionDetail
      session={session}
      isOrchestrator={sessionIsOrchestrator}
      orchestratorZones={zoneCounts ?? undefined}
      projectOrchestratorId={projectOrchestratorId}
      projects={projects}
      sidebarSessions={sidebarSessions}
    />
  );
}
