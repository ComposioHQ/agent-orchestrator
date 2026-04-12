import type { Session } from "@composio/ao-core";
import { isOrchestratorSession, isTerminalSession } from "@composio/ao-core/types";
import type { Orchestrator } from "@/components/OrchestratorSelector";

/**
 * Filter and map sessions to orchestrator DTOs.
 * Shared between page.tsx and API route to ensure consistent orchestrator listing.
 */
export function mapSessionsToOrchestrators(
  sessions: Session[],
  _sessionPrefix: string,
  projectName: string,
  _allSessionPrefixes?: string[],
): Orchestrator[] {
  return sessions
    .filter((s) => isOrchestratorSession(s) && !isTerminalSession(s))
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
