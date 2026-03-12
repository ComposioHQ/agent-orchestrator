"use client";

import { useEffect, useReducer, useRef } from "react";
import type { DashboardSession, GlobalPauseState, SSESnapshotEvent } from "@/lib/types";

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

  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  useEffect(() => {
    dispatch({ type: "reset", sessions: initialSessions, globalPause: initialGlobalPause ?? null });
  }, [initialSessions, initialGlobalPause]);

  useEffect(() => {
    const url = project ? `/api/events?project=${encodeURIComponent(project)}` : "/api/events";
    const es = new EventSource(url);

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string };
        if (data.type === "snapshot") {
          const snapshot = data as SSESnapshotEvent;
          dispatch({ type: "snapshot", patches: snapshot.sessions });

          const currentIds = new Set(sessionsRef.current.map((s) => s.id));
          const snapshotIds = new Set(snapshot.sessions.map((s) => s.id));
          const sameMembership =
            currentIds.size === snapshotIds.size &&
            [...snapshotIds].every((id) => currentIds.has(id));

          if (!sameMembership && !refreshingRef.current) {
            refreshingRef.current = true;
            const sessionsUrl = project
              ? `/api/sessions?project=${encodeURIComponent(project)}`
              : "/api/sessions";
            void fetch(sessionsUrl)
              .then((res) => (res.ok ? res.json() : null))
              .then(
                (
                  updated: { sessions?: DashboardSession[]; globalPause?: GlobalPauseState } | null,
                ) => {
                  if (updated?.sessions) {
                    dispatch({
                      type: "reset",
                      sessions: updated.sessions,
                      globalPause: updated.globalPause ?? null,
                    });
                  }
                },
              )
              .catch(() => undefined)
              .finally(() => {
                refreshingRef.current = false;
              });
          }
        }
      } catch {
        return;
      }
    };

    es.onerror = () => undefined;

    return () => {
      es.close();
    };
  }, [project]);

  return state;
}
