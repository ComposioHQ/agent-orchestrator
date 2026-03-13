import type { OrchestratorConfig } from "@composio/ao-core";

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Check whether a session name matches a project prefix (strict: prefix-\d+ only). */
export function matchesPrefix(sessionName: string, prefix: string): boolean {
  return new RegExp(`^${escapeRegex(prefix)}-\\d+$`).test(sessionName);
}

/** Find which project a session belongs to by matching its name against session prefixes. */
export function findProjectForSession(
  config: OrchestratorConfig,
  sessionName: string,
): string | null {
  for (const [id, project] of Object.entries(config.projects) as Array<
    [string, OrchestratorConfig["projects"][string]]
  >) {
    const prefix = project.sessionPrefix || id;
    if (matchesPrefix(sessionName, prefix)) {
      return id;
    }
  }
  return null;
}

export function isOrchestratorSessionName(
  config: OrchestratorConfig,
  sessionName: string,
  projectId?: string,
): boolean {
  if (projectId) {
    const project = config.projects[projectId];
    if (project && sessionName === `${project.sessionPrefix || projectId}-orchestrator`) {
      return true;
    }
  }

  for (const [id, project] of Object.entries(config.projects) as Array<
    [string, OrchestratorConfig["projects"][string]]
  >) {
    const prefix = project.sessionPrefix || id;
    if (sessionName === `${prefix}-orchestrator`) {
      return true;
    }
  }

  return sessionName.endsWith("-orchestrator");
}
