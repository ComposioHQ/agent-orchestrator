import * as TaskManager from "expo-task-manager";
import * as BackgroundTask from "expo-background-task";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getAttentionLevel, type AttentionLevel, type DashboardSession, type SessionsResponse } from "../types";
import { scheduleNotification } from "./index";

export const TASK_ID = "ao-session-check";
const BACKEND_URL_KEY = "@ao_backend_url";
export const NOTIFY_STATE_KEY = "@ao_notify_state";
const NOTIFY_TIMESTAMPS_KEY = "@ao_notify_timestamps";
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/** Define the background task globally — must be at module top level. */
TaskManager.defineTask(TASK_ID, async () => {
  try {
    const backendUrl = await AsyncStorage.getItem(BACKEND_URL_KEY);
    if (!backendUrl) return BackgroundTask.BackgroundTaskResult.Success;

    const res = await fetch(`${backendUrl}/api/sessions`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return BackgroundTask.BackgroundTaskResult.Failed;

    const data = (await res.json()) as SessionsResponse;
    const sessions: DashboardSession[] = data.sessions ?? [];

    const [prevRaw, tsRaw] = await Promise.all([
      AsyncStorage.getItem(NOTIFY_STATE_KEY),
      AsyncStorage.getItem(NOTIFY_TIMESTAMPS_KEY),
    ]);
    const prevState: Record<string, AttentionLevel> = prevRaw
      ? (JSON.parse(prevRaw) as Record<string, AttentionLevel>)
      : {};
    const timestamps: Record<string, number> = tsRaw
      ? (JSON.parse(tsRaw) as Record<string, number>)
      : {};

    const nextState: Record<string, AttentionLevel> = {};
    const now = Date.now();

    for (const session of sessions) {
      const level = getAttentionLevel(session);
      nextState[session.id] = level;

      const prev = prevState[session.id];
      const lastNotified = timestamps[session.id] ?? 0;
      const cooldownExpired = now - lastNotified > COOLDOWN_MS;

      if (level === "respond" && (prev !== "respond" || cooldownExpired)) {
        scheduleNotification(session, "respond");
        timestamps[session.id] = now;
      } else if (level === "merge" && (prev !== "merge" || cooldownExpired)) {
        scheduleNotification(session, "merge");
        timestamps[session.id] = now;
      }
    }

    await Promise.all([
      AsyncStorage.setItem(NOTIFY_STATE_KEY, JSON.stringify(nextState)),
      AsyncStorage.setItem(NOTIFY_TIMESTAMPS_KEY, JSON.stringify(timestamps)),
    ]);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Register the background task. Safe to call multiple times. */
export async function registerBackgroundTask(): Promise<void> {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_ID);
    if (isRegistered) return;

    await BackgroundTask.registerTaskAsync(TASK_ID, {
      minimumInterval: 15 * 60, // 15 minutes (OS minimum)
    });
  } catch {
    // Background tasks are not supported in Expo Go — ignore silently
  }
}
