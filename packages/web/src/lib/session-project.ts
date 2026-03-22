import type { OrchestratorConfig } from "@composio/ao-core";

export function resolveProjectIdForSessionId(
  config: OrchestratorConfig,
  sessionId: string,
): string | undefined {
  for (const [projectId, project] of Object.entries(config.projects)) {
    const prefix = project.sessionPrefix;
    if (sessionId === prefix || sessionId.startsWith(`${prefix}-`)) {
      return projectId;
    }
  }
  return undefined;
}
