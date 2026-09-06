/** Normalized harness authentication states published by the daemon. */
export type AgentAuthenticationState = "authorized" | "unauthorized" | "unknown" | "not_applicable";

/**
 * A harness counts as signed in when the daemon observed it as authorized, or
 * decided it needs no authentication at all. Both mean the user must not be
 * asked to sign in, so this is the only predicate the UI should use to present
 * a harness as usable. Comparing against `authorized` alone silently excludes
 * API-key and no-auth harnesses, and mirrors the daemon's
 * `AgentAuthenticationState.SignedIn`.
 */
export function agentAuthenticationSignedIn(state: AgentAuthenticationState): boolean {
	return state === "authorized" || state === "not_applicable";
}
