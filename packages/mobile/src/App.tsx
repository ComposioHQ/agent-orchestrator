import React, { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import { BackendProvider } from "./context/BackendContext";
import RootNavigator from "./navigation/RootNavigator";
import { navigationRef } from "./navigation/RootNavigator";
import { setupNotifications } from "./notifications";
import { registerBackgroundTask } from "./notifications/backgroundTask";

/** Navigate to a session when a notification is tapped. */
function handleNotificationResponse(response: Notifications.NotificationResponse) {
  const data = response.notification.request.content.data as
    | { sessionId?: string }
    | undefined;
  const sessionId = data?.sessionId;
  if (!sessionId) return;

  // Wait for navigation to be ready (cold-start case)
  const tryNavigate = () => {
    if (navigationRef.isReady()) {
      navigationRef.navigate("SessionDetail", { sessionId });
    } else {
      setTimeout(tryNavigate, 100);
    }
  };
  tryNavigate();
}

export default function App() {
  useEffect(() => {
    void setupNotifications();
    void registerBackgroundTask();

    // Handle notification tapped while app was killed or in background
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) handleNotificationResponse(response);
    });

    // Handle notification tapped while app is running
    const sub = Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <BackendProvider>
        <RootNavigator />
      </BackendProvider>
    </SafeAreaProvider>
  );
}
