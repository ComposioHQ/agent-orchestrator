"use client";

import { useEffect, useReducer } from "react";
import type { DashboardSession, SSESnapshotEvent } from "@/lib/types";

type Action =
  | { type: "reset"; sessions: DashboardSession[] }
  | { type: "snapshot"; patches: SSESnapshotEvent["sessions"] };

function reducer(state: DashboardSession[], action: Action): DashboardSession[] {
  switch (action.type) {
    case "reset":
      return action.sessions;
    case "snapshot": {
      const patchMap = new Map(action.patches.map((p) => [p.id, p]));
      let changed = false;
      const next = state.map((s) => {
        const patch = patchMap.get(s.id);
        if (!patch) return s;

        // Check if basic session fields changed
        const basicChanged =
          s.status !== patch.status ||
          s.activity !== patch.activity ||
          s.lastActivityAt !== patch.lastActivityAt;

        // Check if PR status fields changed (from cached PR data in SSE)
        const prChanged =
          s.pr !== null &&
          patch.prState !== undefined &&
          patch.prState !== null &&
          (s.pr.state !== patch.prState ||
            s.pr.ciStatus !== patch.ciStatus ||
            s.pr.reviewDecision !== patch.reviewDecision);

        if (!basicChanged && !prChanged) return s;

        changed = true;
        const updated = { ...s, status: patch.status, activity: patch.activity, lastActivityAt: patch.lastActivityAt };

        // Apply PR status patches if present
        if (updated.pr && patch.prState !== undefined && patch.prState !== null) {
          updated.pr = {
            ...updated.pr,
            state: patch.prState,
            ...(patch.ciStatus !== undefined && patch.ciStatus !== null && { ciStatus: patch.ciStatus }),
            ...(patch.reviewDecision !== undefined && patch.reviewDecision !== null && { reviewDecision: patch.reviewDecision }),
          };
        }

        return updated;
      });
      return changed ? next : state;
    }
  }
}

export function useSessionEvents(initialSessions: DashboardSession[]): DashboardSession[] {
  const [sessions, dispatch] = useReducer(reducer, initialSessions);

  // Reset state when server-rendered props change (e.g. full page refresh)
  useEffect(() => {
    dispatch({ type: "reset", sessions: initialSessions });
  }, [initialSessions]);

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string };
        if (data.type === "snapshot") {
          const snapshot = data as SSESnapshotEvent;
          dispatch({ type: "snapshot", patches: snapshot.sessions });
        }
      } catch {
        // Ignore malformed messages
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here
    };

    return () => {
      es.close();
    };
  }, []);

  return sessions;
}
