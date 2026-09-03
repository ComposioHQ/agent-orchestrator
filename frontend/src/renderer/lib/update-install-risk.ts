import type { AgentProvider } from "../types/workspace";

/**
 * Which sessions actually lose work when the app quits to install an update.
 *
 * Quitting is NOT uniformly destructive, and treating it as if it were would
 * warn on almost every session and teach the user to click through:
 *
 * - TUI sessions run their agent in a detached tmux/conpty runtime, so the
 *   runtime outlives the app and the next boot adopts it.
 * - Chat sessions on the Codex provider run in a detached per-session host
 *   (backend/internal/adapters/chatdriver/persistenthost), which exists so a
 *   daemon or desktop replacement reconnects without stopping an in-flight turn.
 * - Every other Chat driver keeps daemon-owned process lifetime, so its process
 *   dies with the daemon and an in-flight turn is lost.
 *
 * Only the last group is at risk, and only while a turn could be in flight.
 * `working` is the obvious case; `no_signal` is a live session whose agent has
 * not reported in, so AO cannot rule out a turn and must assume one.
 */
export const PERSISTENT_CHAT_PROVIDERS: ReadonlySet<AgentProvider> = new Set<AgentProvider>(["codex"]);

const TURN_MAY_BE_IN_FLIGHT: ReadonlySet<string> = new Set(["working", "no_signal"]);

export type UpdateRiskSession = {
	id: string;
	title: string;
	workspaceName: string;
	provider: AgentProvider;
	/** Optional on WorkspaceSession; an unset mode is not a chat session. */
	mode?: "chat" | "tui";
	status: string;
	isTerminated?: boolean;
};

/** The sessions a restart-to-update would cost an in-flight turn. */
export function sessionsAtRiskFromInstall<T extends UpdateRiskSession>(sessions: readonly T[]): T[] {
	return sessions.filter(
		(session) =>
			session.isTerminated !== true &&
			session.mode === "chat" &&
			!PERSISTENT_CHAT_PROVIDERS.has(session.provider) &&
			TURN_MAY_BE_IN_FLIGHT.has(session.status),
	);
}
