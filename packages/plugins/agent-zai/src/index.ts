import type { Agent, AgentLaunchConfig, PluginModule } from "@composio/ao-core";
import claudeCodePlugin from "@composio/ao-plugin-agent-claude-code";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "zai",
  slot: "agent" as const,
  description: "Agent plugin: z.ai (GLM) via Claude Code compatible API",
  version: "0.1.0",
};

const DEFAULT_ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
const DEFAULT_ZAI_API_KEY_ENV = "ZAI_API_KEY";

function readEnvVar(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function readAgentConfigString(config: AgentLaunchConfig, key: string): string | undefined {
  const value = config.projectConfig.agentConfig?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveModel(config: AgentLaunchConfig): string | undefined {
  return config.model ?? readAgentConfigString(config, "zaiModel");
}

function resolveBaseUrl(config: AgentLaunchConfig): string {
  return (
    readAgentConfigString(config, "zaiBaseUrl") ??
    readEnvVar("ZAI_ANTHROPIC_BASE_URL") ??
    DEFAULT_ZAI_ANTHROPIC_BASE_URL
  );
}

function resolveApiKeyEnvName(config: AgentLaunchConfig): string {
  return readAgentConfigString(config, "zaiApiKeyEnv") ?? DEFAULT_ZAI_API_KEY_ENV;
}

function resolveAuthToken(config: AgentLaunchConfig): string {
  const apiKeyEnv = resolveApiKeyEnvName(config);
  const token = readEnvVar(apiKeyEnv) ?? readEnvVar("ANTHROPIC_AUTH_TOKEN");
  if (token) return token;

  throw new Error(
    `Missing z.ai auth token. Set ${apiKeyEnv} (recommended) or ANTHROPIC_AUTH_TOKEN in your environment.`,
  );
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createZaiAgent(): Agent {
  const claudeAgent = claudeCodePlugin.create();

  return {
    ...claudeAgent,
    name: "zai",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const model = resolveModel(config);
      const launchConfig = model ? { ...config, model } : config;
      return claudeAgent.getLaunchCommand(launchConfig);
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env = claudeAgent.getEnvironment(config);
      return {
        ...env,
        ANTHROPIC_BASE_URL: resolveBaseUrl(config),
        ANTHROPIC_AUTH_TOKEN: resolveAuthToken(config),
      };
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createZaiAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
