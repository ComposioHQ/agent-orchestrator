"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { notFound, useParams } from "next/navigation";
import { ACTIVITY_STATE, SESSION_STATUS, isOrchestratorSession } from "@aoagents/ao-core/types";
import { SessionDetail } from "@/components/SessionDetail";
import { type DashboardSession, type ActivityState, getAttentionLevel } from "@/lib/types";
import { activityIcon } from "@/lib/activity-icons";
import type { ProjectInfo } from "@/lib/project-name";
import { getSessionTitle } from "@/lib/format";
import { useSSESessionActivity } from "@/hooks/useSSESessionActivity";
import { useMuxOptional } from "@/providers/MuxProvider";
import type { SessionPatch } from "@/lib/mux-protocol";

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

// NOTE: No `action` field here by design. This status strip is a detail-page
// summary, and `SessionDetail.OrchestratorZones` (the consumer of these
// counts) only renders the detailed 5-zone breakdown. `getAttentionLevel()`
// below is called without a mode so it defaults to "detailed" and never
// returns "action" — the strip stays in detailed mode independent of the
// dashboard's `attentionZones` config.
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

let cachedProjects: ProjectInfo[] | null = null;
let cachedSidebarSessions: DashboardSession[] | null = null;
const validSessionStatuses = new Set<string>(Object.values(SESSION_STATUS));
const validActivityStates = new Set<string>(Object.values(ACTIVITY_STATE));
const warnedMuxPatchValues = new Set<string>();

function isDashboardSessionStatus(value: string): value is DashboardSession["status"] {
  return validSessionStatuses.has(value);
}

function isActivityState(value: string): value is ActivityState {
  return validActivityStates.has(value);
}

function areProjectsEqual(previous: ProjectInfo[] | null, next: ProjectInfo[]): boolean {
  if (!previous || previous.length !== next.length) {
    return false;
  }

  return previous.every((project, index) => {
    const candidate = next[index];
    return JSON.stringify(project) === JSON.stringify(candidate);
  });
}

function areSidebarSessionsEqual(
  previous: DashboardSession[] | null,
  next: DashboardSession[],
): boolean {
  if (!previous || previous.length !== next.length) {
    return false;
  }

  return previous.every((session, index) => {
    const candidate = next[index];
    return JSON.stringify(session) === JSON.stringify(candidate);
  });
}

function applyMuxSessionPatches(current: DashboardSession[] | null, patches: SessionPatch[]): DashboardSession[] | null {
  if (!current || patches.length === 0) {
    return current;
  }

  const patchById = new Map(patches.map((patch) => [patch.id, patch]));
  let changed = false;

  const next = current.map((session) => {
    const patch = patchById.get(session.id);
    if (!patch) {
      return session;
    }

    if (!isDashboardSessionStatus(patch.status)) {
      const warningKey = `status:${patch.status}`;
      if (!warnedMuxPatchValues.has(warningKey)) {
        warnedMuxPatchValues.add(warningKey);
        console.warn("Ignoring mux session patch with unknown status", {
          sessionId: patch.id,
          status: patch.status,
        });
      }
      return session;
    }

    if (patch.activity !== null && !isActivityState(patch.activity)) {
      const warningKey = `activity:${patch.activity}`;
      if (!warnedMuxPatchValues.has(warningKey)) {
        warnedMuxPatchValues.add(warningKey);
        console.warn("Ignoring mux session patch with unknown activity", {
          sessionId: patch.id,
          activity: patch.activity,
        });
      }
      return session;
    }

    if (
      session.status === patch.status &&
      session.activity === patch.activity &&
      session.lastActivityAt === patch.lastActivityAt
    ) {
      return session;
    }

    changed = true;
    const nextSession: DashboardSession = {
      ...session,
      status: patch.status,
      activity: patch.activity,
      lastActivityAt: patch.lastActivityAt,
    };
    return nextSession;
  });

  return changed ? next : current;
}

export default function SessionPage() {
  const params = useParams();
  const id = params.id as string;
  const mux = useMuxOptional();

  // Read optimistic session data written by sidebar navigation (instant render, no white screen)
  const cachedSession = (() => {
    if (typeof sessionStorage === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(`ao-session-nav:${id}`);
      if (raw) {
        sessionStorage.removeItem(`ao-session-nav:${id}`);
        return JSON.parse(raw) as DashboardSession;
      }
    } catch { /* ignore */ }
    return null;
  })();

  const [session, setSession] = useState<DashboardSession | null>(cachedSession);
  const [zoneCounts, setZoneCounts] = useState<ZoneCounts | null>(null);
  const [projectOrchestratorId, setProjectOrchestratorId] = useState<string | null | undefined>(undefined);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sidebarSessions, setSidebarSessions] = useState<DashboardSession[] | null>(() => cachedSidebarSessions);
  const [loading, setLoading] = useState(cachedSession === null);
  const [routeError, setRouteError] = useState<Error | null>(null);
  const [sessionMissing, setSessionMissing] = useState(false);
  const [sidebarError, setSidebarError] = useState(false);
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
  const hasLoadedSessionRef = useRef(cachedSession !== null);
  const pendingMuxSessionsRef = useRef<SessionPatch[] | null>(null);
  // In-flight guards — prevent concurrent duplicate fetches
  const fetchingSessionRef = useRef(false);
  const fetchingProjectSessionsRef = useRef(false);
  const fetchingSidebarRef = useRef(false);

  // Keep prefixByProjectRef in sync so fetchProjectSessions (stable [] dep) reads latest map
  useEffect(() => {
    prefixByProjectRef.current = prefixByProject;
  }, [prefixByProject]);

  // Fetch project prefix map once on mount so isOrchestratorSession can use the correct prefix
  const fetchProjects = useCallback(async () => {
    if (cachedProjects) {
      setProjects(cachedProjects);
      setPrefixByProject(
        new Map(cachedProjects.map((p) => [p.id, p.sessionPrefix ?? p.id])),
      );
    }

    try {
      const res = await fetch("/api/projects");
      if (!res.ok) {
        console.error("Failed to fetch projects:", new Error(`HTTP ${res.status}`));
        return;
      }
      const data = (await res.json()) as { projects?: ProjectInfo[] } | null;
      if (!data?.projects) return;
      if (!areProjectsEqual(cachedProjects, data.projects)) {
        cachedProjects = data.projects;
        setProjects(data.projects);
        setPrefixByProject(
          new Map(data.projects.map((p) => [p.id, p.sessionPrefix ?? p.id])),
        );
      }
    } catch (err) {
      console.error("Failed to fetch projects:", err);
    }
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
    if (fetchingSessionRef.current) return;
    fetchingSessionRef.current = true;
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
      fetchingSessionRef.current = false;
    }
  }, [id]);

  const fetchProjectSessions = useCallback(async () => {
    if (fetchingProjectSessionsRef.current) return;
    const projectId = sessionProjectIdRef.current;
    if (!projectId) return;
    fetchingProjectSessionsRef.current = true;
    const isOrchestrator = sessionIsOrchestratorRef.current;
    const projectSessionsKey = `${projectId}:${isOrchestrator ? "orchestrator" : "worker"}`;
    if (!isOrchestrator && resolvedProjectSessionsKeyRef.current === projectSessionsKey) return;
    try {
      const query = isOrchestrator
        ? `/api/sessions?project=${encodeURIComponent(projectId)}`
        : `/api/sessions?project=${encodeURIComponent(projectId)}&orchestratorOnly=true`;
      const res = await fetch(query);
      if (!res.ok) {
        console.error("Failed to fetch project sessions for", projectId, new Error(`HTTP ${res.status}`));
        return;
      }
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
          // Detailed mode by default — "action" never appears. The guard
          // is a compile-time narrowing hint for the index below.
          const level = getAttentionLevel(s);
          if (level === "action") continue;
          counts[level]++;
        }
      }
      setZoneCounts(counts);
    } catch {
      // non-critical - status strip just won't show
    } finally {
      fetchingProjectSessionsRef.current = false;
    }
  }, []);

  const fetchSidebarSessions = useCallback(async () => {
    if (fetchingSidebarRef.current) return;
    fetchingSidebarRef.current = true;
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { sessions?: DashboardSession[] } | null;
      const restSessions = body?.sessions ?? [];
      const nextSessions =
        applyMuxSessionPatches(restSessions, pendingMuxSessionsRef.current ?? []) ?? restSessions;
      cachedSidebarSessions = nextSessions;
      setSidebarError(false);
      setSidebarSessions((current) => (
        areSidebarSessionsEqual(current, nextSessions) ? current : nextSessions
      ));
    } catch (err) {
      console.error("Failed to fetch sidebar sessions:", err);
      setSidebarError(true);
      setSidebarSessions((current) => (current === null ? [] : current));
    } finally {
      fetchingSidebarRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!mux?.sessions) return;

    // Only overlay mux snapshots onto REST refreshes while the WebSocket is
    // live. After a disconnect `mux.sessions` retains the last snapshot, which
    // would silently overwrite fresher REST data via `pendingMuxSessionsRef`.
    if (mux.status !== "connected") {
      pendingMuxSessionsRef.current = null;
      return;
    }

    pendingMuxSessionsRef.current = mux.sessions;

    // Read current sessions via the module-level cache so this effect reacts to
    // new mux data only — keeping `sidebarSessions` out of the dep array avoids
    // re-running on every state change that the effect itself produces.
    const next = applyMuxSessionPatches(cachedSidebarSessions, mux.sessions);
    if (next !== cachedSidebarSessions) {
      cachedSidebarSessions = next;
      setSidebarSessions(next);
    }

    if (mux.sessions.length === 0 || !cachedSidebarSessions) {
      return;
    }

    const cachedIds = new Set(cachedSidebarSessions.map((sidebarSession) => sidebarSession.id));
    const muxIds = new Set(mux.sessions.map((muxSession) => muxSession.id));
    if (cachedIds.size !== muxIds.size) {
      void fetchSidebarSessions();
      return;
    }

    for (const muxId of muxIds) {
      if (!cachedIds.has(muxId)) {
        void fetchSidebarSessions();
        return;
      }
    }
  }, [fetchSidebarSessions, mux?.sessions, mux?.status]);

  useEffect(() => {
    if (!sessionIsOrchestrator) {
      setZoneCounts(null);
    }
  }, [sessionIsOrchestrator]);

  // Initial fetch — load independent sidebar/session data in parallel.
  useEffect(() => {
    void Promise.all([
      fetchProjects(),
      fetchSession(),
      fetchSidebarSessions(),
    ]);
  }, [fetchProjects, fetchSession, fetchSidebarSessions]);

  useEffect(() => {
    if (!sessionProjectId) return;
    void fetchProjectSessions();
  }, [fetchProjectSessions, sessionIsOrchestrator, sessionProjectId]);

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
      sidebarLoading={sidebarSessions === null}
      sidebarError={sidebarError}
      onRetrySidebar={fetchSidebarSessions}
    />
  );
}
