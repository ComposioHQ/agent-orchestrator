import type { OrchestratorConfig } from "@aoagents/ao-core";

export function resolveProjectIdForSessionId(
  config: OrchestratorConfig,
  sessionId: string,
): string | undefined {
  for (const [projectId, project] of Object.entries(config.projects)) {
    if (typeof project.resolveError === "string" && project.resolveError.length > 0) continue;
    const prefix = project.sessionPrefix;
    if (sessionId === prefix || sessionId.startsWith(`${prefix}-`)) {
      return projectId;
    }
  }
  return undefined;
}
