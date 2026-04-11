"use client";

import { useEffect, useReducer, useRef, useCallback } from "react";
import {
  getAttentionLevel,
  type AttentionLevel,
  type DashboardSession,
  type SSESnapshotEvent,
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
  connectionStatus: ConnectionStatus;
  /** Attention levels from the latest SSE snapshot (server-computed, includes PR state). */
  sseAttentionLevels: SSEAttentionMap;
}

type Action =
  | { type: "reset"; sessions: DashboardSession[]; sseAttentionLevels?: SSEAttentionMap }
  | { type: "snapshot"; patches: SSESnapshotEvent["sessions"] }
  | { type: "setConnection"; status: ConnectionStatus };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return {
        ...state,
        sessions: action.sessions,
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
        return { ...s, status: patch.status, activity: patch.activity, lastActivityAt: patch.lastActivityAt };
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
  project?: string,
  muxSessions?: Array<{ id: string; status: string; activity: string | null; attentionLevel: string; lastActivityAt: string }>,
  initialAttentionLevels?: SSEAttentionMap,
  disabled = false,
): State {
  const [state, dispatch] = useReducer(reducer, {
    sessions: initialSessions,
    connectionStatus: "connected" as ConnectionStatus,
    sseAttentionLevels: initialAttentionLevels ?? ({} as SSEAttentionMap),
  });
  const sessionsRef = useRef(state.sessions);
  const initialAttentionLevelsRef = useRef(initialAttentionLevels);
  initialAttentionLevelsRef.current = initialAttentionLevels;
  const refreshingRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMembershipKeyRef = useRef<string | null>(null);
  const lastRefreshAtRef = useRef(0);
  const disconnectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRefreshControllerRef = useRef<AbortController | null>(null);

  // Reset state when server-rendered props change (e.g. full page refresh)
  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  useEffect(() => {
    dispatch({
      type: "reset",
      sessions: initialSessions,
      sseAttentionLevels: initialAttentionLevelsRef.current ?? ({} as SSEAttentionMap),
    });
  }, [initialSessions]);

  // Stable boolean — only changes when mux transitions between present/absent,
  // not on every new snapshot array reference. Used in the SSE effect deps so
  // SSE setup/teardown runs only on that transition, not every mux update.
  const muxActive = muxSessions !== undefined;

  // Define scheduleRefresh with useCallback so both effects can use it
  const scheduleRefresh = useCallback(() => {
    if (refreshingRef.current || refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refreshingRef.current = true;
      const requestedMembershipKey = pendingMembershipKeyRef.current;
      const refreshController = new AbortController();
      activeRefreshControllerRef.current = refreshController;

      const sessionsUrl = project
        ? `/api/sessions?project=${encodeURIComponent(project)}`
        : "/api/sessions";

      void fetch(sessionsUrl, { signal: refreshController.signal })
        .then((res) => (res.ok ? res.json() : null))
        .then(
          (updated: { sessions?: DashboardSession[] } | null) => {
            if (refreshController.signal.aborted || !updated?.sessions) {
              // Update timestamp even for non-OK responses to prevent retry storms
              if (!refreshController.signal.aborted) {
                lastRefreshAtRef.current = Date.now();
              }
              return;
            }

            lastRefreshAtRef.current = Date.now();
            const sseAttentionLevels = Object.fromEntries(
              updated.sessions.map((s) => [s.id, getAttentionLevel(s)]),
            ) as SSEAttentionMap;
            dispatch({
              type: "reset",
              sessions: updated.sessions,
              sseAttentionLevels,
            });
          },
        )
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          console.warn("[useSessionEvents] refresh failed:", err);
          // Update timestamp on failure to prevent retry loops on every SSE snapshot
          lastRefreshAtRef.current = Date.now();
        })
        .finally(() => {
          if (activeRefreshControllerRef.current === refreshController) {
            activeRefreshControllerRef.current = null;
          }
          if (refreshController.signal.aborted) {
            refreshingRef.current = false;
            // If there's still a pending membership change, reschedule so it isn't lost
            if (pendingMembershipKeyRef.current !== null) {
              scheduleRefresh();
            }
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
  }, [project]);

  // Mux-based session updates (replaces SSE when available)
  useEffect(() => {
    if (disabled || !muxSessions) return;
    // Note: empty array is intentional — it means all sessions were removed and we
    // must still run the membership-key comparison to trigger scheduleRefresh().

    // muxSessions is global (all projects). Filter to only sessions in the
    // current project-scoped state so we don't trigger spurious refreshes
    // when viewing a single-project page.
    const currentIds = new Set(sessionsRef.current.map((s) => s.id));
    const scopedMuxSessions = muxSessions.filter((s) => currentIds.has(s.id));
    // The mux feed is global, but the page is project-scoped. We can't tell from
    // a mux patch whether an unknown ID belongs to this project — only /api/sessions
    // knows. So if we see ANY id we don't have, trigger a refresh to find out.
    const hasUnknownIds = muxSessions.some((s) => !currentIds.has(s.id));

    dispatch({ type: "snapshot", patches: scopedMuxSessions as SSESnapshotEvent["sessions"] });

    const currentMembershipKey = createMembershipKey(sessionsRef.current);
    const snapshotMembershipKey = createMembershipKey(scopedMuxSessions);

    if (hasUnknownIds || currentMembershipKey !== snapshotMembershipKey) {
      pendingMembershipKeyRef.current = snapshotMembershipKey;
      scheduleRefresh();
    } else if (Date.now() - lastRefreshAtRef.current >= STALE_REFRESH_INTERVAL_MS) {
      scheduleRefresh();
    }

    return () => {
      // Only abort in-flight requests — do NOT clear the debounce timer.
      // Cancelling the timer here would prevent the membership-change refresh
      // from completing when muxSessions updates arrive in rapid succession.
      activeRefreshControllerRef.current?.abort();
      activeRefreshControllerRef.current = null;
    };
  }, [disabled, muxSessions, scheduleRefresh]);

  useEffect(() => {
    if (disabled) return;

    // Skip SSE if mux sessions are available
    if (muxActive) {
      dispatch({ type: "setConnection", status: "connected" });
      return () => {
        // Clear timer and reset all refresh state so the aborted fetch's
        // .finally() handler doesn't reschedule after unmount.
        if (refreshTimerRef.current) {
          clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
        pendingMembershipKeyRef.current = null;
        refreshingRef.current = false;
        activeRefreshControllerRef.current?.abort();
        activeRefreshControllerRef.current = null;
      };
    }

    // Reset so the new project gets an immediate first refresh on its first SSE snapshot
    lastRefreshAtRef.current = 0;

    const url = project ? `/api/events?project=${encodeURIComponent(project)}` : "/api/events";
    const es = new EventSource(url);
    let disposed = false;

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
      activeRefreshControllerRef.current?.abort();
      activeRefreshControllerRef.current = null;
      refreshingRef.current = false;
      pendingMembershipKeyRef.current = null;
      clearRefreshTimer();
      clearDisconnectedTimer();
      es.close();
    };
  }, [disabled, project, muxActive, scheduleRefresh]);

  return state;
}
