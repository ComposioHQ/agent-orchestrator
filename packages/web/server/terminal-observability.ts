import {
  createProjectObserver,
  loadConfig,
  type OrchestratorConfig,
  type ProjectObserver,
} from "@composio/ao-core";

export function createObserverContext(surface: string): {
  config: OrchestratorConfig | undefined;
  observer: ProjectObserver | undefined;
} {
  try {
    const config = loadConfig();
    return {
      config,
      observer: createProjectObserver(config, surface),
    };
  } catch {
    return { config: undefined, observer: undefined };
  }
}

export function inferProjectId(
  config: OrchestratorConfig | undefined,
  sessionId: string,
): string | undefined {
  if (!config) {
    return undefined;
  }

  for (const [projectId, project] of Object.entries(config.projects)) {
    const prefix = project.sessionPrefix;
    if (sessionId === prefix || sessionId.startsWith(`${prefix}-`)) {
      return projectId;
    }
  }

  return undefined;
}
