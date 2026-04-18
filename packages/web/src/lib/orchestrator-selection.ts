import type { ProjectConfig, Session } from "@aoagents/ao-core";
import { isOrchestratorSession, isTerminalSession } from "@aoagents/ao-core/types";

export const PROJECT_ORCHESTRATOR_IDLE_REPLACEMENT_THRESHOLD_MS = 10 * 60_000;

type OrchestratorHealthCandidate = Pick<Session, "status" | "activity" | "lastActivityAt">;

export function isProjectOrchestratorReplaceable(
  session: OrchestratorHealthCandidate,
  now = Date.now(),
): boolean {
  if (session.status === "stuck") return true;
  if (session.activity !== "idle") return false;

  const lastActivityAt = session.lastActivityAt;
  const lastActivityTs =
    lastActivityAt instanceof Date ? lastActivityAt.getTime() : new Date(lastActivityAt).getTime();

  if (!Number.isFinite(lastActivityTs)) return false;
  return now - lastActivityTs >= PROJECT_ORCHESTRATOR_IDLE_REPLACEMENT_THRESHOLD_MS;
}

export function filterCurrentProjectOrchestrators(
  sessions: Session[],
  projects: Record<string, ProjectConfig>,
  now = Date.now(),
): Session[] {
  const allSessionPrefixes = Object.entries(projects).map(
    ([projectId, project]) => project.sessionPrefix ?? projectId,
  );

  return sessions.filter((session) => {
    const sessionPrefix = projects[session.projectId]?.sessionPrefix ?? session.projectId;
    return isCurrentProjectOrchestrator(session, sessionPrefix, allSessionPrefixes, now);
  });
}

export function isCurrentProjectOrchestrator(
  session: Session,
  sessionPrefix?: string,
  allSessionPrefixes?: string[],
  now = Date.now(),
): boolean {
  return (
    isOrchestratorSession(session, sessionPrefix, allSessionPrefixes) &&
    !isTerminalSession(session) &&
    !isProjectOrchestratorReplaceable(session, now)
  );
}
