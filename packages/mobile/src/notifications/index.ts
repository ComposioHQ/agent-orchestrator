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
export async function scheduleNotification(
  session: DashboardSession,
  level: "respond" | "merge" | "review",
): Promise<void> {
  const sessionLabel =
    session.issueLabel ??
    session.id;

  const body =
    session.issueTitle ??
    (session.summary && !session.summaryIsFallback ? session.summary : null) ??
    session.activity ??
    session.status;

  const titles: Record<typeof level, string> = {
    respond: "Agent needs your input",
    merge: "PR ready to merge",
    review: "Session needs review",
  };

  const bodies: Record<typeof level, string> = {
    respond: `${sessionLabel}: ${body}`,
    merge: `${sessionLabel}${session.pr ? `: PR #${session.pr.number}` : ""}`,
    review: `${sessionLabel}: ${session.pr?.ciStatus === "failing" ? "CI failing" : session.pr?.reviewDecision === "changes_requested" ? "Changes requested" : body}`,
  };

  const content: Notifications.NotificationContentInput = {
    title: titles[level],
    body: bodies[level],
    data: { sessionId: session.id },
    sound: true,
    ...(Platform.OS === "android" && { channelId: ANDROID_CHANNEL_ID }),
  };

  // Use timeInterval trigger instead of null — trigger: null fails silently on Android in background tasks.
  // SDK 53 requires explicit `type` field on trigger objects.
  await Notifications.scheduleNotificationAsync({
    content,
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 1,
      channelId: Platform.OS === "android" ? ANDROID_CHANNEL_ID : undefined,
    },
  });
}
