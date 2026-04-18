import type { Session } from "@aoagents/ao-core";
import type { Orchestrator } from "@/components/OrchestratorSelector";
import { isCurrentProjectOrchestrator } from "@/lib/orchestrator-selection";

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
  return sessions
    .filter((session) =>
      isCurrentProjectOrchestrator(session, sessionPrefix, allSessionPrefixes),
    )
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
