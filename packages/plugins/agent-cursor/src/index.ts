import {
  createAgentPlugin,
  toAgentProjectPath,
  resetPsCache as _resetPsCache,
  type AgentPluginConfig,
} from "@composio/ao-plugin-agent-base";
import type { Agent, PluginModule, Session } from "@composio/ao-core";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "cursor",
  slot: "agent" as const,
  description: "Agent plugin: Cursor Agent CLI",
  version: "0.1.0",
};

// =============================================================================
// Project Path Encoder (alias for tests)
// =============================================================================

/** Convert a workspace path to Cursor's project directory path. */
export const toCursorProjectPath = toAgentProjectPath;

// =============================================================================
// Plugin Config
// =============================================================================

const cursorConfig: AgentPluginConfig = {
  name: "cursor",
  description: "Agent plugin: Cursor Agent CLI",
  processName: "cursor-agent",
  command: "cursor-agent",
  configDir: ".cursor",
  // Cursor Agent CLI uses --force (equivalent of --yolo / --dangerously-skip-permissions)
  permissionlessFlag: "--force",
  // Cursor Agent CLI does not support a system prompt flag;
  // system prompts are delivered post-launch via sendMessage().
  systemPromptFlag: undefined,
  // Cursor Agent CLI does not expose per-token costs in JSONL.
  // Claude pricing is used as a placeholder until Cursor adds cost data.
  defaultCostRate: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
};

// =============================================================================
// Cursor-specific overrides
// Cursor stores sessions in SQLite at ~/.cursor/chats/, but also writes JSONL
// to ~/.cursor/projects/ so the base getSessionInfo implementation works.
// getRestoreCommand returns null until SQLite introspection is implemented.
// =============================================================================

const cursorOverrides: Partial<Agent> = {
  async getRestoreCommand(_session: Session): Promise<string | null> {
    // TODO: Implement via SQLite from ~/.cursor/chats/
    return null;
  },
};

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAgentPlugin(cursorConfig, cursorOverrides);
}

/** Reset the ps process cache. Exported for testing only. */
export const resetPsCache = _resetPsCache;

export default { manifest, create } satisfies PluginModule<Agent>;
