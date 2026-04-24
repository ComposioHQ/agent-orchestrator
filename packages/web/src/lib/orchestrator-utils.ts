import { getOrchestratorSessionId, type Session } from "@aoagents/ao-core";
import { isOrchestratorSession, isTerminalSession } from "@aoagents/ao-core/types";
import type { Orchestrator } from "@/components/OrchestratorSelector";

/**
 * Filter and map sessions to orchestrator DTOs.
 * Shared between page.tsx and API route to ensure consistent orchestrator listing.
 */
export function mapSessionsToOrchestrators(
  sessions: Session[],
  sessionPrefix: string,
  projectName: string,
  allSessionPrefixes?: string[],
): Orchestrator[] {
  const canonicalId = getOrchestratorSessionId({ sessionPrefix });
  return sessions
    .filter((s) => isOrchestratorSession(s, sessionPrefix, allSessionPrefixes) && !isTerminalSession(s))
    .sort((a, b) => {
      if (a.id === canonicalId) return -1;
      if (b.id === canonicalId) return 1;
      return (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0);
    })
    .map((s) => ({
      id: s.id,
      projectId: s.projectId,
      projectName,
      status: s.status,
      activity: s.activity,
      createdAt: s.createdAt?.toISOString() ?? null,
      lastActivityAt: s.lastActivityAt?.toISOString() ?? null,
    }));
}
