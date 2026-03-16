import {
  createAgentPlugin,
  toAgentProjectPath,
  resetPsCache as _resetPsCache,
  type AgentPluginConfig,
} from "@composio/ao-plugin-agent-base";
import type { Agent, PluginModule } from "@composio/ao-core";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "claude-code",
  slot: "agent" as const,
  description: "Agent plugin: Claude Code CLI",
  version: "0.1.0",
};

// =============================================================================
// Project Path Encoder (alias for tests)
// =============================================================================

/** Convert a workspace path to Claude Code's project directory path. */
export const toClaudeProjectPath = toAgentProjectPath;

// =============================================================================
// Plugin Config
// =============================================================================

const claudeCodeConfig: AgentPluginConfig = {
  name: "claude-code",
  description: "Agent plugin: Claude Code CLI",
  processName: "claude",
  command: "claude",
  configDir: ".claude",
  permissionlessFlag: "--dangerously-skip-permissions",
  systemPromptFlag: "--append-system-prompt",
  // Sonnet 4.5 pricing as baseline ($3/M input, $15/M output).
  // Will be inaccurate for Opus/Haiku. TODO: make configurable or infer from JSONL.
  defaultCostRate: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
};

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAgentPlugin(claudeCodeConfig);
}

/** Reset the ps process cache. Exported for testing only. */
export const resetPsCache = _resetPsCache;

export default { manifest, create } satisfies PluginModule<Agent>;
