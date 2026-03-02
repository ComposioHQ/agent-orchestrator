import React, { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BackendProvider } from "./context/BackendContext";
import RootNavigator from "./navigation/RootNavigator";
import { setupNotifications } from "./notifications";
import { registerBackgroundTask } from "./notifications/backgroundTask";

export default function App() {
  useEffect(() => {
    void setupNotifications();
    void registerBackgroundTask();
  }, []);

  return (
    <SafeAreaProvider>
      <BackendProvider>
        <RootNavigator />
      </BackendProvider>
    </SafeAreaProvider>
  );
}
