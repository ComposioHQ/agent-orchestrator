import {
  createAgentPlugin,
  resetPsCache as _resetPsCache,
  type AgentPluginConfig,
} from "@composio/ao-plugin-agent-base";
import { execFileSync } from "node:child_process";
import type { Agent, PluginModule, ProjectConfig, Session } from "@composio/ao-core";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "gemini",
  slot: "agent" as const,
  description: "Agent plugin: Gemini CLI",
  version: "0.1.0",
};

// =============================================================================
// Project Path Encoder
// =============================================================================

/**
 * Convert a workspace path to Gemini's project directory hash.
 * Gemini CLI uses SHA-256 of the workspace path to name its project directory
 * (`~/.gemini/tmp/<hash>/chats/`), unlike Claude Code which uses path-mangling.
 *
 * Exported for testing.
 */
export function toGeminiProjectPath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  return createHash("sha256").update(normalized).digest("hex");
}

// =============================================================================
// Plugin Config
// =============================================================================

const geminiConfig: AgentPluginConfig = {
  name: "gemini",
  description: "Agent plugin: Gemini CLI",
  processName: "gemini",
  command: "gemini",
  configDir: ".gemini",
  // Gemini CLI uses --yolo (equivalent of --dangerously-skip-permissions)
  permissionlessFlag: "--yolo",
  // Gemini CLI does not support a system prompt CLI flag; prompts are delivered
  // post-launch via sendMessage(), or inline via the GEMINI_SYSTEM_MD env var.
  systemPromptFlag: undefined,
  systemPromptEnvVar: "GEMINI_SYSTEM_MD",
  // Gemini CLI does not expose a direct cost field in JSON session files.
  // Usage fields may still be present and are parsed when available; no
  // built-in price model is configured for monetary estimates.
  // Gemini CLI stores sessions at ~/.gemini/tmp/<sha256(workspacePath)>/chats/
  // (SHA-256 encoding), not the path-mangling scheme used by Claude Code.
  getSessionDir: (workspacePath: string) =>
    join(homedir(), ".gemini", "tmp", toGeminiProjectPath(workspacePath), "chats"),
  // Gemini CLI session files use .json extension, not .jsonl
  sessionFileExtension: ".json",
  // Gemini CLI uses "run_shell_command" for shell execution, not "Bash"
  hookToolMatcher: "run_shell_command",
  // Gemini CLI uses AfterTool hook events, not PostToolUse
  hookEvent: "AfterTool",
};

// =============================================================================
// Gemini-specific overrides
// Gemini CLI does not support session restore via CLI flag (no --resume equivalent).
// getRestoreCommand returns null - sessions must be restored manually or via UI.
// =============================================================================

const geminiOverrides: Partial<Agent> = {
  async getRestoreCommand(_session: Session, _project: ProjectConfig): Promise<string | null> {
    // Gemini CLI does not have a --resume flag; sessions are restored via UI
    return null;
  },
};

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAgentPlugin(geminiConfig, geminiOverrides);
}

/** Reset the ps process cache. Exported for testing only. */
export const resetPsCache = _resetPsCache;

export function detect(): boolean {
  try {
    execFileSync("gemini", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
