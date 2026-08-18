// WebSocket client helper for the daemon's Android emulator frame relay
// (`/api/v1/android-device/stream`). The wire protocol is one binary WS
// message per frame, each message the raw bytes of one PNG screenshot (see
// backend/internal/httpd/controllers/androiddevice.go's stream handler) —
// no JSON envelope, unlike the terminal mux.

const androidStreamPath = "/api/v1/android-device/stream";

// Derive the ws(s)://.../api/v1/android-device/stream URL from the REST API
// base, mirroring terminal-mux.ts's muxUrlFromApiBase exactly (same daemon,
// same loopback-only reasoning).
export function androidStreamUrlFromApiBase(apiBaseUrl: string): string {
	if (apiBaseUrl === "" && typeof window !== "undefined") {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		return `${protocol}//${window.location.host}${androidStreamPath}`;
	}

	const ws = apiBaseUrl.replace(/^http/i, "ws");
	return `${ws.replace(/\/+$/, "")}${androidStreamPath}`;
}
