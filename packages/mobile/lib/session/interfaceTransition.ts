import type { SessionInterfaceTransitionStatus } from "../chat/api";

type InterfaceTransition = { phase: string };

type InterfaceTransitionStatus = Pick<SessionInterfaceTransitionStatus, "reasonCode" | "reason"> & {
	transition?: InterfaceTransition;
};

const activePhases = new Set([
	"requested",
	"preflighting",
	"draining",
	"source_stopping",
	"source_stopped",
	"target_starting",
	"activating",
]);

// Transient: the daemon reports these until the terminal's session-start hook
// proves which native conversation it is running, so rechecking is what lets the
// switch enable itself. Slow, because they are not guaranteed to clear — a
// `--resume` relaunch stays UNVERIFIED (#4122).
const nativeSessionReadinessCodes = new Set(["NATIVE_SESSION_MISSING", "NATIVE_SESSION_UNVERIFIED"]);
const nativeSessionReadinessPoll = 1_000;

export function mobileInterfaceTransitionIsActive(transition?: InterfaceTransition): boolean {
	return Boolean(transition && activePhases.has(transition.phase));
}

export function mobileInterfaceTransitionIsCancellable(transition?: InterfaceTransition): boolean {
	return Boolean(
		transition && ["requested", "preflighting", "draining"].includes(transition.phase),
	);
}

function nativeSessionReadinessPending(status?: InterfaceTransitionStatus): boolean {
	return Boolean(status?.reasonCode && nativeSessionReadinessCodes.has(status.reasonCode));
}

export function interfaceTransitionPollInterval(status?: InterfaceTransitionStatus): number | undefined {
	if (mobileInterfaceTransitionIsActive(status?.transition)) return 300;
	if (nativeSessionReadinessPending(status)) return nativeSessionReadinessPoll;
	return undefined;
}

// The daemon's reason is a Go error: fair for a verdict, useless for a wait.
export function interfaceSwitchUnavailableMessage(
	status?: InterfaceTransitionStatus,
	fallbackError?: string,
): string {
	if (nativeSessionReadinessPending(status)) {
		return "The terminal has not confirmed its agent conversation yet. Try again in a moment, or send the terminal a message first.";
	}
	return (
		status?.reason ||
		fallbackError ||
		"This agent has not declared a compatible native conversation handoff."
	);
}
