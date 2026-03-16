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
  // Cursor Agent CLI uses --force (equivalent of --dangerously-skip-permissions)
  permissionlessFlag: "--force",
  // No systemPromptFlag — Cursor Agent CLI does not support one;
  // system prompts are delivered post-launch via sendMessage().
  // No defaultCostRate — Cursor does not expose per-token costs.
};

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  const agent = createAgentPlugin(cursorConfig);

  // Cursor stores sessions in SQLite at ~/.cursor/chats/, not as JSONL files.
  // Override the base JSONL-based methods to return null until SQLite
  // introspection is implemented. isProcessRunning still works, so we
  // preserve the "exited" state when the process is gone.
  agent.getActivityState = async (session) => {
    const exitedAt = new Date();
    if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
    const running = await agent.isProcessRunning(session.runtimeHandle);
    if (!running) return { state: "exited", timestamp: exitedAt };
    return null;
  };

  agent.getSessionInfo = async () => null;
  agent.getRestoreCommand = async () => null;

  return agent;
}

/** Reset the ps process cache. Exported for testing only. */
export const resetPsCache = _resetPsCache;

export default { manifest, create } satisfies PluginModule<Agent>;
