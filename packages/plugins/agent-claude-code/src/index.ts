import {
  createAgentPlugin,
  toAgentProjectPath,
  resetPsCache as _resetPsCache,
  METADATA_UPDATER_SCRIPT as _METADATA_UPDATER_SCRIPT,
  type AgentPluginConfig,
} from "@composio/ao-plugin-agent-base";
import { execFileSync } from "node:child_process";
import type { Agent, PluginModule } from "@composio/ao-core";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "claude-code",
  slot: "agent" as const,
  description: "Agent plugin: Claude Code CLI",
  version: "0.1.0",
  displayName: "Claude Code",
};

// =============================================================================
// Project Path Encoder (alias for tests)
// =============================================================================

/**
 * Convert a workspace path to Claude's project directory path.
 * Follows Claude Code's actual encoding: strips leading /, replaces / and . with -.
 * e.g. /Users/dev/.worktrees/ao → Users-dev--worktrees-ao
 */
export const toClaudeProjectPath = toAgentProjectPath;

// =============================================================================
// Hook Script (re-exported from agent-base for testing)
// =============================================================================

/**
 * Hook script with "Bash" substituted for the tool-matcher placeholder.
 * Claude Code uses the "Bash" tool for shell commands.
 * Exported for integration testing.
 */
export const METADATA_UPDATER_SCRIPT = _METADATA_UPDATER_SCRIPT.replace(
  "__AO_HOOK_TOOL_MATCHER__",
  "Bash",
);

// =============================================================================
// Plugin Config
// =============================================================================

const claudeConfig: AgentPluginConfig = {
  name: "claude-code",
  description: "Agent plugin: Claude Code CLI",
  processName: "claude",
  command: "claude",
  configDir: ".claude",
  permissionlessFlag: "--dangerously-skip-permissions",
  // Claude Code uses --append-system-prompt for system prompt injection
  systemPromptFlag: "--append-system-prompt",
  // Fallback pricing when JSONL has token counts but no direct cost field.
  // Sonnet 4.5 rates — will be inaccurate for other models (Opus, Haiku).
  defaultCostRate: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  // Prevent nested Claude Code instances from detecting they are inside Claude Code.
  unsetClaudeEnv: true,
};

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAgentPlugin(claudeConfig);
}

/** Reset the ps process cache. Exported for testing only. */
export const resetPsCache = _resetPsCache;

export function detect(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
