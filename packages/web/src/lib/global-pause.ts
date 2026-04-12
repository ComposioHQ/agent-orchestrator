import type { Session } from "@aoagents/ao-core";
import type { GlobalPauseState } from "@/lib/types";

/**
 * Scan all sessions for an active global pause signal.
 * Orchestrator sessions set globalPauseUntil in their metadata when they
 * want all agents in the workspace to pause (e.g. during a rate-limit window).
 */
export function resolveGlobalPause(sessions: Session[]): GlobalPauseState | null {
  const now = new Date();
  for (const session of sessions) {
    const pausedUntil = session.metadata?.["globalPauseUntil"];
    if (typeof pausedUntil !== "string") continue;
    if (new Date(pausedUntil) <= now) continue; // expired pause

    return {
      pausedUntil,
      reason: (session.metadata?.["globalPauseReason"] as string) ?? null,
      sourceSessionId: (session.metadata?.["globalPauseSource"] as string) ?? session.id,
    };
  }
  return null;
}
