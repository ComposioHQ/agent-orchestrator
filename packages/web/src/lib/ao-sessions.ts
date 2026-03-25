import { resolveProjectIdForSessionId, type OrchestratorConfig, type Session } from "@composio/ao-core";
import { sessionToDashboard } from "@/lib/serialize";
import type { DashboardSession } from "@/lib/types";

export function normalizeSessionProjectId(
  session: Session,
  config: OrchestratorConfig,
): string {
  if (config.projects[session.projectId]) {
    return session.projectId;
  }

  return resolveProjectIdForSessionId(config, session.id) ?? session.projectId;
}

export function toAODashboardSession(
  session: Session,
  config: OrchestratorConfig,
): DashboardSession {
  return toDashboardSessionWithNormalizedProject(session, config);
}

export function toDashboardSessionWithNormalizedProject(
  session: Session,
  config: OrchestratorConfig,
): DashboardSession {
  return {
    ...sessionToDashboard(session),
    projectId: normalizeSessionProjectId(session, config),
  };
}
