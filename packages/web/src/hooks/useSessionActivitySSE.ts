"use client";

import { useEffect, useRef } from "react";
import type { DashboardSession, SSESnapshotEvent } from "@/lib/types";

/**
 * Lightweight SSE hook for a single session detail page.
 * Subscribes to /api/events and patches the session's activity, status,
 * and lastActivityAt in real-time from snapshot events.
 *
 * NOTE: This intentionally opens its own EventSource rather than reusing
 * useSessionEvents, which is designed for the dashboard (manages an array
 * of all sessions via useReducer). This hook is scoped to a single session
 * and uses a simple callback, keeping the session detail page independent.
 *
 * Returns nothing — mutates the session via the provided callback.
 */
export function useSessionActivitySSE(
  sessionId: string,
  onUpdate: (patch: { activity: DashboardSession["activity"]; status: DashboardSession["status"]; lastActivityAt: string }) => void,
): void {
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string };
        if (data.type === "snapshot") {
          const snapshot = data as SSESnapshotEvent;
          const match = snapshot.sessions.find((s) => s.id === sessionId);
          if (match) {
            onUpdateRef.current({
              activity: match.activity,
              status: match.status,
              lastActivityAt: match.lastActivityAt,
            });
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
    };
  }, [sessionId]);
}
