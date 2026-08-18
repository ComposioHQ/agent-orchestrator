// Pure, testable core for consuming AO's Android emulator frame relay
// (`/api/v1/android-device/stream`): one binary WS message per PNG frame, no
// JSON envelope. Mirrors terminal-mux.ts's factory shape (an injectable
// WebSocket implementation, an imperative return value) so it is unit
// testable without a live daemon; the React-facing hook (useAndroidFrameStream)
// is a thin, untested wrapper around this, matching how useTerminalSession
// wraps createTerminalMux.

export type AndroidFrameStream = {
	close: () => void;
};

export function createAndroidFrameStream(
	url: string,
	onFrame: (data: ArrayBuffer) => void,
	onConnectedChange: (connected: boolean) => void,
	WebSocketImpl: typeof WebSocket = WebSocket,
): AndroidFrameStream {
	const socket = new WebSocketImpl(url);
	socket.binaryType = "arraybuffer";
	socket.onopen = () => onConnectedChange(true);
	socket.onclose = () => onConnectedChange(false);
	socket.onerror = () => onConnectedChange(false);
	socket.onmessage = (event) => onFrame(event.data as ArrayBuffer);

	return {
		close: () => socket.close(),
	};
}
