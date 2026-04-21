import type { Session } from "@aoagents/ao-core";
import { isOrchestratorSession, isTerminalSession } from "@aoagents/ao-core/types";
import type { Orchestrator } from "@/components/OrchestratorSelector";

/**
 * Filter and map sessions to orchestrator DTOs.
 * Shared between page.tsx and API route to ensure consistent orchestrator listing.
 */
function compareOrchestratorRecency(
  a: Pick<Session, "id" | "lastActivityAt" | "createdAt">,
  b: Pick<Session, "id" | "lastActivityAt" | "createdAt">,
): number {
  return (
    (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0) ||
    (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

function listProjectOrchestratorSessions(
  sessions: Session[],
  sessionPrefix: string,
  allSessionPrefixes?: string[],
): Session[] {
  const projectOrchestrators = sessions
    .filter((s) => isOrchestratorSession(s, sessionPrefix, allSessionPrefixes) && !isTerminalSession(s))
    .sort(compareOrchestratorRecency);

  if (projectOrchestrators.length > 0) {
    return projectOrchestrators;
  }

  return sessions
    .filter((s) => isOrchestratorSession(s, sessionPrefix, allSessionPrefixes))
    .sort(compareOrchestratorRecency);
}

export function selectCanonicalProjectOrchestrator(
  sessions: Session[],
  sessionPrefix: string,
  allSessionPrefixes?: string[],
): Session | null {
  return listProjectOrchestratorSessions(sessions, sessionPrefix, allSessionPrefixes)[0] ?? null;
}

export function mapSessionToOrchestrator(
  session: Session,
  projectName: string,
): Orchestrator {
  return {
    id: session.id,
    projectId: session.projectId,
    projectName,
    status: session.status,
    activity: session.activity,
    createdAt: session.createdAt?.toISOString() ?? null,
    lastActivityAt: session.lastActivityAt?.toISOString() ?? null,
  };
}

export function mapSessionsToOrchestrators(
  sessions: Session[],
  sessionPrefix: string,
  projectName: string,
  allSessionPrefixes?: string[],
): Orchestrator[] {
  const canonical = selectCanonicalProjectOrchestrator(sessions, sessionPrefix, allSessionPrefixes);
  return canonical ? [mapSessionToOrchestrator(canonical, projectName)] : [];
}
