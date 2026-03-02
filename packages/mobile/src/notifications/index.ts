import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { DashboardSession } from "../types";

const ANDROID_CHANNEL_ID = "ao-respond";

/** Configure how notifications are presented when the app is in foreground */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/** Create Android channel + request permission. Call once on app startup. */
export async function setupNotifications(): Promise<boolean> {
  // Create Android notification channel
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: "Agent Input Required",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#f85149",
    });
  }

  const { status } = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: false,
      allowSound: true,
    },
  });

  return status === "granted";
}

/** Fire an immediate local notification for a session attention transition. */
export function scheduleNotification(
  session: DashboardSession,
  level: "respond" | "merge",
): void {
  const sessionLabel =
    session.issueLabel ??
    session.id;

  const body =
    session.issueTitle ??
    (session.summary && !session.summaryIsFallback ? session.summary : null) ??
    session.activity ??
    session.status;

  const content: Notifications.NotificationContentInput =
    level === "respond"
      ? {
          title: "Agent needs your input",
          body: `${sessionLabel}: ${body}`,
          data: { sessionId: session.id },
          sound: true,
          ...(Platform.OS === "android" && { channelId: ANDROID_CHANNEL_ID }),
        }
      : {
          title: "PR ready to merge",
          body: `${sessionLabel}${session.pr ? `: PR #${session.pr.number}` : ""}`,
          data: { sessionId: session.id },
          sound: true,
          ...(Platform.OS === "android" && { channelId: ANDROID_CHANNEL_ID }),
        };

  // Fire immediately (trigger: null = instant)
  void Notifications.scheduleNotificationAsync({ content, trigger: null });
}
