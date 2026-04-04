import {
  GLOBAL_PAUSE_REASON_KEY,
  GLOBAL_PAUSE_SOURCE_KEY,
  GLOBAL_PAUSE_UNTIL_KEY,
  isOrchestratorSession,
  parsePauseUntil,
} from "@composio/ao-core";

export interface GlobalPauseState {
  pausedUntil: string;
  reason: string;
  sourceSessionId: string | null;
}

export function resolveGlobalPause(
  sessions: Array<{ id: string; projectId: string; metadata: Record<string, string> }>,
  projects: Record<string, { sessionPrefix?: string }>,
): GlobalPauseState | null {
  const allSessionPrefixes = Object.entries(projects).map(
    ([projectId, p]) => p.sessionPrefix ?? projectId,
  );
  let best: { pausedUntil: string; reason: string; sourceSessionId: string | null } | null = null;
  for (const session of sessions) {
    const sessionPrefix = projects[session.projectId]?.sessionPrefix ?? session.projectId;
    if (!isOrchestratorSession(session, sessionPrefix, allSessionPrefixes)) continue;
    const parsed = parsePauseUntil(session.metadata[GLOBAL_PAUSE_UNTIL_KEY]);
    if (!parsed || parsed.getTime() <= Date.now()) continue;

    if (!best || parsed.getTime() > new Date(best.pausedUntil).getTime()) {
      best = {
        pausedUntil: parsed.toISOString(),
        reason: session.metadata[GLOBAL_PAUSE_REASON_KEY] ?? "Model rate limit reached",
        sourceSessionId: session.metadata[GLOBAL_PAUSE_SOURCE_KEY] ?? null,
      };
    }
  }

  return best;
}
