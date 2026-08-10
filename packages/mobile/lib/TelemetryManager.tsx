import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { initMobileTelemetry, mobileTelemetry, telemetryActiveStorage } from "./telemetry/runtime";

// Headless. Mounted once in the app shell beside PushManager. Initialises the
// PostHog client and emits the daily-active heartbeat on launch and on each
// return to the foreground (which catches a UTC-day rollover while the app was
// backgrounded). The reservation caps it to once per UTC day regardless.
export function TelemetryManager() {
	useEffect(() => {
		initMobileTelemetry();
		void mobileTelemetry()?.active(telemetryActiveStorage);

		const onChange = (state: AppStateStatus) => {
			if (state === "active") {
				void mobileTelemetry()?.active(telemetryActiveStorage);
			} else if (state === "background") {
				// Drain the batch when leaving the foreground so a launch heartbeat or
				// a last feature_used is not stranded if the app is killed while
				// backgrounded. Only "background" (not the transient iOS "inactive")
				// so this does not fire on every notification-center peek.
				mobileTelemetry()?.flush();
			}
		};
		const sub = AppState.addEventListener("change", onChange);
		return () => sub.remove();
	}, []);

	return null;
}
