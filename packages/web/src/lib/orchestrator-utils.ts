import {
  type Session,
  isOrchestratorSession,
} from "@aoagents/ao-core";
import type { Orchestrator } from "@/components/OrchestratorSelector";

export function selectCanonicalProjectOrchestrator(
  sessions: Session[],
  sessionPrefix: string,
  allSessionPrefixes?: string[],
): Session | null {
  return (
    sessions.find(
      (session) =>
        session.id === `${sessionPrefix}-orchestrator` &&
        isOrchestratorSession(session, sessionPrefix, allSessionPrefixes),
    ) ?? null
  );
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
