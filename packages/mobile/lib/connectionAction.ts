/**
 * What to do when something wakes the connection.
 *
 * Kept as a pure decision so the policy is testable on its own, separate from
 * the React and React Native machinery that observes the triggers.
 */

export type ConnectionTrigger =
	| "foreground"
	| "network-change"
	| "heartbeat-miss"
	| "socket-close"
	| "manual-retry";

export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

export type ConnectionState = {
	status: ConnectionStatus;
	/** How long the app was in the background before this wake. */
	backgroundedForMs: number;
	online: boolean;
};

export type ConnectionAction =
	/** Leave the connection alone. */
	| "none"
	/** Check the existing session is still answering, without replacing it. */
	| "probe"
	/** Discard the current endpoint and race the candidates again. */
	| "re-race";

/**
 * How long in the background counts as a real suspension.
 *
 * Below this the OS has almost certainly left the socket intact, so a probe is
 * enough. Above it the socket may have been killed underneath an in-flight
 * attempt, and probing would just be a slower path to the same reconnect.
 */
export const BACKGROUND_SUSPENSION_MS = 30_000;

/**
 * Decides what a wake should do.
 *
 * The important case is foregrounding a healthy session: it is checked, not
 * replaced. Reconnecting on every foreground is what makes an app spin for a
 * few seconds each time it is opened, and the session is usually fine.
 */
export function actionFor(trigger: ConnectionTrigger, state: ConnectionState): ConnectionAction {
	// A manual retry is the user saying they know better, so it is honoured even
	// while offline — the OS status can lag reality on a flaky network.
	if (trigger === "manual-retry") return "re-race";

	// Offline is not a failure. Racing endpoints with no network spends retry
	// budget and battery to learn what the OS already reported.
	if (!state.online) return "none";

	const suspended = state.backgroundedForMs > BACKGROUND_SUSPENSION_MS;

	if (trigger === "foreground") {
		// A connect already in flight must not be restarted by an unrelated
		// wake; restarting it only delays it. A real suspension is the exception.
		if (state.status === "connecting") return suspended ? "re-race" : "none";
		if (state.status === "connected") return suspended ? "re-race" : "probe";
		return "re-race";
	}

	// Every other trigger means the chosen endpoint is suspect: the network
	// moved, the heartbeat missed, or the socket went away. The LAN address that
	// won at home is a different device on the next network, so the answer is
	// always to race again rather than reuse it.
	return "re-race";
}
