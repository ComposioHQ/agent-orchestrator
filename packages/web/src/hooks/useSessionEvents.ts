"use client";

import { useEffect, useReducer, useRef } from "react";
import type {
  AttentionLevel,
  DashboardSession,
  GlobalPauseState,
  SSESnapshotEvent,
} from "@/lib/types";

/** Debounce before fetching full session list after membership change. */
const MEMBERSHIP_REFRESH_DELAY_MS = 120;
/** Re-fetch full session list if no refresh has happened in this interval. */
const STALE_REFRESH_INTERVAL_MS = 15000;
/** Grace period before declaring "disconnected" (allows for transient reconnects). */
const DISCONNECTED_GRACE_PERIOD_MS = 4000;

type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

/** Server-computed attention levels from the latest SSE snapshot. */
export type SSEAttentionMap = Readonly<Record<string, AttentionLevel>>;


interface State {
  sessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
  connectionStatus: ConnectionStatus;
  /** Attention levels from the latest SSE snapshot (server-computed, includes PR state). */
  sseAttentionLevels: SSEAttentionMap;
}

type Action =
  | { type: "reset"; sessions: DashboardSession[]; globalPause: GlobalPauseState | null; sseAttentionLevels?: SSEAttentionMap }
  | { type: "snapshot"; patches: SSESnapshotEvent["sessions"] }
  | { type: "setConnection"; status: ConnectionStatus };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return {
        ...state,
        sessions: action.sessions,
        globalPause: action.globalPause,
        ...(action.sseAttentionLevels !== undefined
          ? { sseAttentionLevels: action.sseAttentionLevels }
          : {}),
      };
    case "setConnection":
      return { ...state, connectionStatus: action.status };
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

      // Build attention level map from server-computed values
      const levels: Record<string, AttentionLevel> = {};
      for (const p of action.patches) {
        levels[p.id] = p.attentionLevel;
      }

      const sessionsChanged = changed;
      const levelsChanged =
        Object.keys(levels).length !== Object.keys(state.sseAttentionLevels).length ||
        action.patches.some((p) => state.sseAttentionLevels[p.id] !== p.attentionLevel);

      if (!sessionsChanged && !levelsChanged) return state;

      return {
        ...state,
        sessions: sessionsChanged ? next : state.sessions,
        sseAttentionLevels: levelsChanged ? levels : state.sseAttentionLevels,
      };
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

export function useSessionEvents(
  initialSessions: DashboardSession[],
  initialGlobalPause?: GlobalPauseState | null,
  project?: string,
  initialAttentionLevels?: SSEAttentionMap,
): State {
  const [state, dispatch] = useReducer(reducer, {
    sessions: initialSessions,
    globalPause: initialGlobalPause ?? null,
    connectionStatus: "connected" as ConnectionStatus,
    sseAttentionLevels: initialAttentionLevels ?? ({} as SSEAttentionMap),
  });
  const sessionsRef = useRef(state.sessions);
  const initialAttentionLevelsRef = useRef(initialAttentionLevels);
  initialAttentionLevelsRef.current = initialAttentionLevels;
  const refreshingRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMembershipKeyRef = useRef<string | null>(null);
  const lastRefreshAtRef = useRef(Date.now());
  const disconnectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  useEffect(() => {
    dispatch({
      type: "reset",
      sessions: initialSessions,
      globalPause: initialGlobalPause ?? null,
      sseAttentionLevels: initialAttentionLevelsRef.current ?? ({} as SSEAttentionMap),
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

    const clearDisconnectedTimer = () => {
      if (disconnectedTimerRef.current) {
        clearTimeout(disconnectedTimerRef.current);
        disconnectedTimerRef.current = null;
      }
    };

    const scheduleRefresh = () => {
      if (disposed) return;
      if (refreshingRef.current || refreshTimerRef.current) return;
      refreshTimerRef.current = setTimeout(() => {
        if (disposed) return;
        refreshTimerRef.current = null;
        refreshingRef.current = true;
        const requestedMembershipKey = pendingMembershipKeyRef.current;
        const refreshController = new AbortController();
        activeRefreshController = refreshController;

        const sessionsUrl = project
          ? `/api/sessions?project=${encodeURIComponent(project)}`
          : "/api/sessions";

        void fetch(sessionsUrl, { signal: refreshController.signal })
          .then((res) => (res.ok ? res.json() : null))
          .then(
            (updated: { sessions?: DashboardSession[]; globalPause?: GlobalPauseState } | null) => {
              if (disposed || refreshController.signal.aborted || !updated?.sessions) return;

              lastRefreshAtRef.current = Date.now();
              dispatch({
                type: "reset",
                sessions: updated.sessions,
                globalPause: updated.globalPause ?? null,
              });
            },
          )
          .catch((err: unknown) => {
            if (err instanceof DOMException && err.name === "AbortError") return;
            console.warn("[useSessionEvents] refresh failed:", err);
          })
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
      }, MEMBERSHIP_REFRESH_DELAY_MS);
    };

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string };
        if (data.type === "snapshot") {
          const snapshot = data as SSESnapshotEvent;
          dispatch({ type: "snapshot", patches: snapshot.sessions });

          const currentMembershipKey = createMembershipKey(sessionsRef.current);
          const snapshotMembershipKey = createMembershipKey(snapshot.sessions);

          if (currentMembershipKey !== snapshotMembershipKey) {
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

    es.onopen = () => {
      clearDisconnectedTimer();
      if (!disposed) dispatch({ type: "setConnection", status: "connected" });
    };

    es.onerror = () => {
      if (disposed) return;

      if (es.readyState === EventSource.CLOSED) {
        clearDisconnectedTimer();
        dispatch({ type: "setConnection", status: "disconnected" });
        return;
      }

      dispatch({ type: "setConnection", status: "reconnecting" });

      if (disconnectedTimerRef.current === null) {
        disconnectedTimerRef.current = setTimeout(() => {
          disconnectedTimerRef.current = null;
          if (!disposed && es.readyState !== EventSource.OPEN) {
            dispatch({ type: "setConnection", status: "disconnected" });
          }
        }, DISCONNECTED_GRACE_PERIOD_MS);
      }
    };

    return () => {
      disposed = true;
      activeRefreshController?.abort();
      activeRefreshController = null;
      refreshingRef.current = false;
      pendingMembershipKeyRef.current = null;
      clearRefreshTimer();
      clearDisconnectedTimer();
      es.close();
    };
  }, [project]);

  return state;
}
