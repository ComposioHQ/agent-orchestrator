import {
  createAgentPlugin,
  toAgentProjectPath,
  resetPsCache as _resetPsCache,
  type AgentPluginConfig,
} from "@composio/ao-plugin-agent-base";
import { execFileSync } from "node:child_process";
import type { Agent, PluginModule, ProjectConfig, Session } from "@composio/ao-core";

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

/**
 * Convert a workspace path to Cursor's project directory path.
 * Cursor follows the same path-mangling behavior as Claude Code.
 */
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
  // Cursor Agent CLI does not expose a direct cost field in JSONL.
  // Usage fields may still be present and are parsed when available; no
  // built-in price model is configured for monetary estimates.
};

// =============================================================================
// Cursor-specific overrides
// Cursor stores sessions in SQLite at ~/.cursor/chats/ and can also write
// JSONL snapshots under ~/.cursor/projects/.
// getRestoreCommand returns null until SQLite introspection is implemented.
// =============================================================================

const cursorOverrides: Partial<Agent> = {
  async getRestoreCommand(_session: Session, _project: ProjectConfig): Promise<string | null> {
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

export function detect(): boolean {
  try {
    execFileSync("cursor-agent", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
