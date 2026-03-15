"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  AttentionLevel,
  DashboardPayload,
  DashboardSession,
  DashboardView,
  GlobalPauseState,
  SSESnapshotEvent,
} from "@/lib/types";
import { ATTENTION_LEVEL_ORDER, getAttentionLevel } from "@/lib/types";

const MEMBERSHIP_REFRESH_DELAY_MS = 120;
const STALE_REFRESH_INTERVAL_MS = 15000;
const ALIGNMENT_SETTLING_WINDOW_MS = 2500;

interface State {
  sessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
}

export interface DashboardAlignmentState {
  affectedLevels: AttentionLevel[];
  currentCounts: Record<AttentionLevel, number>;
  expectedCounts: Record<AttentionLevel, number>;
  expectedMembershipCount: number;
  status: "aligned" | "drifted" | "settling";
}

type Action =
  | { type: "reset"; sessions: DashboardSession[]; globalPause: GlobalPauseState | null }
  | { type: "snapshot"; patches: SSESnapshotEvent["sessions"] };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return { sessions: action.sessions, globalPause: action.globalPause };
    case "snapshot": {
      const patchMap = new Map(action.patches.map((p) => [p.id, p]));
      let changed = false;
      const next = state.sessions.map((s) => {
        const patch = patchMap.get(s.id);
        if (!patch) return s;
        if (
          s.status === patch.status &&
          s.activity === patch.activity &&
          s.lastActivityAt === patch.lastActivityAt
        ) {
          return s;
        }
        changed = true;
        return {
          ...s,
          status: patch.status,
          activity: patch.activity,
          lastActivityAt: patch.lastActivityAt,
        };
      });
      return changed ? { ...state, sessions: next } : state;
    }
  }
}

function createMembershipKey(
  sessions: Array<Pick<DashboardSession, "id">> | SSESnapshotEvent["sessions"],
): string {
  return sessions
    .map((session) => session.id)
    .sort()
    .join("\u0000");
}

function createAttentionCounts(): Record<AttentionLevel, number> {
  return {
    merge: 0,
    respond: 0,
    review: 0,
    pending: 0,
    working: 0,
    done: 0,
  };
}

function buildCurrentAttentionCounts(
  sessions: DashboardSession[],
): Record<AttentionLevel, number> {
  const counts = createAttentionCounts();
  for (const session of sessions) {
    counts[getAttentionLevel(session)] += 1;
  }
  return counts;
}

function buildSnapshotAttentionCounts(
  sessions: SSESnapshotEvent["sessions"],
): Record<AttentionLevel, number> {
  const counts = createAttentionCounts();
  for (const session of sessions) {
    if (session.attentionLevel in counts) {
      counts[session.attentionLevel as AttentionLevel] += 1;
    }
  }
  return counts;
}

function getAffectedLevels(
  currentCounts: Record<AttentionLevel, number>,
  expectedCounts: Record<AttentionLevel, number>,
): AttentionLevel[] {
  return ATTENTION_LEVEL_ORDER.filter((level) => currentCounts[level] !== expectedCounts[level]);
}

export function useSessionEvents(
  initialSessions: DashboardSession[],
  initialGlobalPause?: GlobalPauseState | null,
  project?: string,
  view: DashboardView = "legacy",
): State & { alignment: DashboardAlignmentState; refreshNow: () => void } {
  const [state, dispatch] = useReducer(reducer, {
    sessions: initialSessions,
    globalPause: initialGlobalPause ?? null,
  });
  const [alignment, setAlignment] = useState<DashboardAlignmentState>({
    affectedLevels: [],
    currentCounts: buildCurrentAttentionCounts(initialSessions),
    expectedCounts: buildCurrentAttentionCounts(initialSessions),
    expectedMembershipCount: initialSessions.length,
    status: "aligned",
  });
  const sessionsRef = useRef(state.sessions);
  const refreshingRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMembershipKeyRef = useRef<string | null>(null);
  const lastRefreshAtRef = useRef(Date.now());
  const alignmentStartedAtRef = useRef<number | null>(null);
  const refreshNowRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  useEffect(() => {
    dispatch({ type: "reset", sessions: initialSessions, globalPause: initialGlobalPause ?? null });
    const counts = buildCurrentAttentionCounts(initialSessions);
    alignmentStartedAtRef.current = null;
    setAlignment({
      affectedLevels: [],
      currentCounts: counts,
      expectedCounts: counts,
      expectedMembershipCount: initialSessions.length,
      status: "aligned",
    });
  }, [initialSessions, initialGlobalPause]);

  useEffect(() => {
    const url = project ? `/api/events?project=${encodeURIComponent(project)}` : "/api/events";
    const es = new EventSource(url);
    let disposed = false;
    let activeRefreshController: AbortController | null = null;

    const clearRefreshTimer = () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };

    const resetAlignment = (sessions: DashboardSession[]) => {
      const counts = buildCurrentAttentionCounts(sessions);
      alignmentStartedAtRef.current = null;
      setAlignment({
        affectedLevels: [],
        currentCounts: counts,
        expectedCounts: counts,
        expectedMembershipCount: sessions.length,
        status: "aligned",
      });
    };

    const updateAlignment = (snapshot: SSESnapshotEvent, membershipChanged: boolean) => {
      const currentCounts = buildCurrentAttentionCounts(sessionsRef.current);
      const hasAttentionLevels = snapshot.sessions.some(
        (session) => typeof session.attentionLevel === "string",
      );
      const expectedCounts = hasAttentionLevels
        ? buildSnapshotAttentionCounts(snapshot.sessions)
        : currentCounts;
      const affectedLevels = hasAttentionLevels
        ? getAffectedLevels(currentCounts, expectedCounts)
        : [];
      const hasMismatch = membershipChanged || affectedLevels.length > 0;

      if (!hasMismatch) {
        resetAlignment(sessionsRef.current);
        return;
      }

      const startedAt = alignmentStartedAtRef.current ?? Date.now();
      alignmentStartedAtRef.current = startedAt;
      setAlignment({
        affectedLevels,
        currentCounts,
        expectedCounts,
        expectedMembershipCount: snapshot.sessions.length,
        status:
          Date.now() - startedAt >= ALIGNMENT_SETTLING_WINDOW_MS ? "drifted" : "settling",
      });
    };

    const runRefresh = (requestedMembershipKey?: string | null) => {
      if (disposed || refreshingRef.current) return;
      refreshingRef.current = true;
      const refreshController = new AbortController();
      activeRefreshController = refreshController;

      const sessionsUrl = project
        ? `/api/sessions?project=${encodeURIComponent(project)}`
        : "/api/sessions";
      const requestUrl =
        view === "legacy"
          ? sessionsUrl
          : `${sessionsUrl}${sessionsUrl.includes("?") ? "&" : "?"}view=${view}`;

      void fetch(requestUrl, { signal: refreshController.signal })
        .then((res) => (res.ok ? res.json() : null))
        .then((updated: DashboardPayload | null) => {
          if (disposed || refreshController.signal.aborted || !updated?.sessions) return;

          lastRefreshAtRef.current = Date.now();
          dispatch({
            type: "reset",
            sessions: updated.sessions,
            globalPause: updated.globalPause ?? null,
          });
          resetAlignment(updated.sessions);
        })
        .catch(() => undefined)
        .finally(() => {
          if (activeRefreshController === refreshController) {
            activeRefreshController = null;
          }
          if (disposed || refreshController.signal.aborted) {
            refreshingRef.current = false;
            return;
          }

          refreshingRef.current = false;

          if (
            pendingMembershipKeyRef.current !== null &&
            pendingMembershipKeyRef.current !== requestedMembershipKey
          ) {
            scheduleRefresh();
            return;
          }

          pendingMembershipKeyRef.current = null;
        });
    };

    const scheduleRefresh = () => {
      if (disposed) return;
      if (refreshingRef.current || refreshTimerRef.current) return;
      refreshTimerRef.current = setTimeout(() => {
        if (disposed) return;
        refreshTimerRef.current = null;
        const requestedMembershipKey = pendingMembershipKeyRef.current;
        runRefresh(requestedMembershipKey);
      }, MEMBERSHIP_REFRESH_DELAY_MS);
    };

    refreshNowRef.current = () => {
      clearRefreshTimer();
      runRefresh(pendingMembershipKeyRef.current);
    };

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string };
        if (data.type === "snapshot") {
          const snapshot = data as SSESnapshotEvent;
          dispatch({ type: "snapshot", patches: snapshot.sessions });

          const currentMembershipKey = createMembershipKey(sessionsRef.current);
          const snapshotMembershipKey = createMembershipKey(snapshot.sessions);
          const membershipChanged = currentMembershipKey !== snapshotMembershipKey;
          updateAlignment(snapshot, membershipChanged);

          if (membershipChanged) {
            pendingMembershipKeyRef.current = snapshotMembershipKey;
            scheduleRefresh();
            return;
          }

          if (Date.now() - lastRefreshAtRef.current >= STALE_REFRESH_INTERVAL_MS) {
            scheduleRefresh();
          }
        }
      } catch {
        return;
      }
    };

    es.onerror = () => undefined;

    return () => {
      disposed = true;
      activeRefreshController?.abort();
      activeRefreshController = null;
      refreshingRef.current = false;
      pendingMembershipKeyRef.current = null;
      refreshNowRef.current = null;
      clearRefreshTimer();
      es.close();
    };
  }, [project, view]);

  const refreshNow = useCallback(() => {
    refreshNowRef.current?.();
  }, []);

  return { ...state, alignment, refreshNow };
}
