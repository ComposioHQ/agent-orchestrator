"use client";

import { useEffect, useReducer, useRef } from "react";
import type { DashboardSession, GlobalPauseState, SSESnapshotEvent } from "@/lib/types";

const MEMBERSHIP_REFRESH_DELAY_MS = 120;
const STALE_REFRESH_INTERVAL_MS = 15000;

interface State {
  sessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
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

        // Check if any field we care about has changed
        const prCiStatusChanged =
          patch.prCiStatus !== undefined &&
          patch.prCiStatus !== null &&
          s.pr !== null &&
          s.pr?.ciStatus !== patch.prCiStatus;
        const prCiChecksChanged =
          patch.prCiChecks !== undefined &&
          patch.prCiChecks !== null &&
          s.pr !== null;

        if (
          s.status === patch.status &&
          s.activity === patch.activity &&
          s.lastActivityAt === patch.lastActivityAt &&
          !prCiStatusChanged &&
          !prCiChecksChanged
        ) {
          return s;
        }
        changed = true;
        return {
          ...s,
          status: patch.status,
          activity: patch.activity,
          lastActivityAt: patch.lastActivityAt,
          // Patch PR CI data when the snapshot includes fresh cache data
          ...(s.pr && patch.prCiStatus !== null && patch.prCiStatus !== undefined
            ? {
                pr: {
                  ...s.pr,
                  ciStatus: patch.prCiStatus,
                  ciChecks: patch.prCiChecks ?? s.pr.ciChecks,
                },
              }
            : {}),
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

export function useSessionEvents(
  initialSessions: DashboardSession[],
  initialGlobalPause?: GlobalPauseState | null,
  project?: string,
): State {
  const [state, dispatch] = useReducer(reducer, {
    sessions: initialSessions,
    globalPause: initialGlobalPause ?? null,
  });
  const sessionsRef = useRef(state.sessions);
  const refreshingRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMembershipKeyRef = useRef<string | null>(null);
  const lastRefreshAtRef = useRef(Date.now());

  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  useEffect(() => {
    dispatch({ type: "reset", sessions: initialSessions, globalPause: initialGlobalPause ?? null });
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

    es.onerror = () => undefined;

    return () => {
      disposed = true;
      activeRefreshController?.abort();
      activeRefreshController = null;
      refreshingRef.current = false;
      pendingMembershipKeyRef.current = null;
      clearRefreshTimer();
      es.close();
    };
  }, [project]);

  return state;
}
