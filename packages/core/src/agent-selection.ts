import {
  normalizeAgentPermissionMode,
  isOrchestratorSession,
  type AgentPermissionMode,
  type AgentSpecificConfig,
  type DefaultPlugins,
  type ProjectConfig,
} from "./types.js";

export type SessionRole = "orchestrator" | "worker";

export interface ResolvedAgentSelection {
  role: SessionRole;
  agentName: string;
  agentConfig: AgentSpecificConfig;
  model?: string;
  permissions?: AgentPermissionMode;
  subagent?: string;
}

export function resolveSessionRole(
  sessionId: string,
  metadata?: Record<string, string>,
): SessionRole {
  return isOrchestratorSession({ id: sessionId, metadata }) ? "orchestrator" : "worker";
}

export function resolveAgentSelection(params: {
  role: SessionRole;
  project: ProjectConfig;
  defaults: DefaultPlugins;
  persistedAgent?: string;
  spawnAgentOverride?: string;
  complexity?: "simple" | "complex";
}): ResolvedAgentSelection {
  const { role, project, defaults, persistedAgent, spawnAgentOverride, complexity } = params;
  const roleProjectConfig = role === "orchestrator" ? project.orchestrator : project.worker;
  const roleDefaults = role === "orchestrator" ? defaults.orchestrator : defaults.worker;
  const sharedConfig = project.agentConfig ?? {};
  const roleAgentConfig = roleProjectConfig?.agentConfig ?? {};

  // For simple worker tasks with no explicit override AND no project-level agent config,
  // route to local-llm. Project-level config is an intentional user choice and takes priority.
  const complexityDefault =
    role === "worker" &&
    !persistedAgent &&
    !spawnAgentOverride &&
    !roleProjectConfig?.agent &&
    !project.agent &&
    complexity === "simple"
      ? "local-llm"
      : undefined;

  const agentName = persistedAgent
    ? persistedAgent
    : role === "worker"
      ? (spawnAgentOverride ??
        roleProjectConfig?.agent ??
        project.agent ??
        complexityDefault ??
        roleDefaults?.agent ??
        defaults.agent)
      : (roleProjectConfig?.agent ?? project.agent ?? roleDefaults?.agent ?? defaults.agent);

  const agentConfig: AgentSpecificConfig = {
    ...sharedConfig,
  };
  for (const [key, value] of Object.entries(roleAgentConfig)) {
    if (value !== undefined) {
      agentConfig[key] = value;
    }
  }

  const model =
    role === "orchestrator"
      ? (roleAgentConfig.orchestratorModel ??
        roleAgentConfig.model ??
        sharedConfig.orchestratorModel ??
        sharedConfig.model)
      : (roleAgentConfig.model ?? sharedConfig.model);

  if (model !== undefined) {
    agentConfig.model = model;
  }

  const permissions = normalizeAgentPermissionMode(
    typeof agentConfig.permissions === "string" ? agentConfig.permissions : undefined,
  );
  if (permissions !== undefined) {
    agentConfig.permissions = permissions;
  }
  const subagent =
    typeof agentConfig["subagent"] === "string" ? agentConfig["subagent"] : undefined;

  return {
    role,
    agentName,
    agentConfig,
    model,
    permissions,
    subagent,
  };
}
