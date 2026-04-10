"use client";

import { useEffect, useState } from "react";
import type { ActivityState, SSESnapshotEvent } from "@/lib/types";

interface SessionActivity {
  activity: ActivityState | null;
}

/**
 * Lightweight SSE subscriber that tracks a single session's activity state.
 *
 * Used by the session detail page to update document.title emoji in real-time
 * without waiting for the full session HTTP poll cycle.
 */
export function useSSESessionActivity(
  sessionId: string,
  project?: string,
): SessionActivity | null {
  const [activity, setActivity] = useState<SessionActivity | null>(null);

  useEffect(() => {
    setActivity(null);
    const url = project ? `/api/events?project=${encodeURIComponent(project)}` : "/api/events";
    const es = new EventSource(url);
    let disposed = false;

    es.onmessage = (event: MessageEvent) => {
      if (disposed) return;
      try {
        const data = JSON.parse(event.data as string) as { type: string };
        if (data.type !== "snapshot") return;

        const snapshot = data as SSESnapshotEvent;
        const match = snapshot.sessions.find((s) => s.id === sessionId);
        if (!match) return;

        setActivity((prev) => {
          if (prev && prev.activity === match.activity) return prev;
          return { activity: match.activity };
        });
      } catch {
        return;
      }
    };

    return () => {
      disposed = true;
      es.close();
    };
  }, [sessionId, project]);

  return activity;
}
