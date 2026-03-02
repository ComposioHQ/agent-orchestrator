import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getAttentionLevel, type AttentionLevel, type DashboardSession } from "../types";
import { scheduleNotification } from "../notifications";
import { NOTIFY_STATE_KEY } from "../notifications/backgroundTask";

/**
 * Minimum time (ms) before re-notifying for the same session.
 * Prevents spam when an agent oscillates between working ↔ waiting_input.
 */
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export function useSessionNotifications(sessions: DashboardSession[]): void {
  const prevLevels = useRef<Record<string, AttentionLevel>>({});
  // Tracks when we last sent a notification per session
  const lastNotifiedAt = useRef<Record<string, number>>({});
  // Skip the very first render — don't notify for state that existed before app opened
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (sessions.length === 0) return;

    const nextLevels: Record<string, AttentionLevel> = {};
    const now = Date.now();
    // Only notify when app is in background — no point interrupting the user
    // if they're actively looking at the session list
    const isBackground = AppState.currentState !== "active";

    for (const session of sessions) {
      const level = getAttentionLevel(session);
      nextLevels[session.id] = level;

      if (!isFirstRender.current) {
        const prev = prevLevels.current[session.id];
        const lastNotified = lastNotifiedAt.current[session.id] ?? 0;
        const cooldownExpired = now - lastNotified > COOLDOWN_MS;

        if (level === "respond" && (prev !== "respond" || cooldownExpired)) {
          if (isBackground || prev !== "respond") {
            scheduleNotification(session, "respond");
            lastNotifiedAt.current[session.id] = now;
          }
        } else if (level === "merge" && (prev !== "merge" || cooldownExpired)) {
          if (isBackground || prev !== "merge") {
            scheduleNotification(session, "merge");
            lastNotifiedAt.current[session.id] = now;
          }
        }
      }
    }

    prevLevels.current = nextLevels;
    isFirstRender.current = false;

    void AsyncStorage.setItem(NOTIFY_STATE_KEY, JSON.stringify(nextLevels));
  }, [sessions]);
}
