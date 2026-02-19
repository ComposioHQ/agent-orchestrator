import {
  shellEscape,
  isAgentProcessRunning,
  DEFAULT_READY_THRESHOLD_MS,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, access } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";

const execFileAsync = promisify(execFile);

// =============================================================================
// Aider Activity Detection Helpers
// =============================================================================

/**
 * Check if Aider has made recent commits (within last 60 seconds).
 */
async function hasRecentCommits(workspacePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--since=60 seconds ago", "--format=%H"],
      { cwd: workspacePath, timeout: 5_000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get modification time of Aider chat history file.
 */
async function getChatHistoryMtime(workspacePath: string): Promise<Date | null> {
  try {
    const chatFile = join(workspacePath, ".aider.chat.history.md");
    await access(chatFile, constants.R_OK);
    const stats = await stat(chatFile);
    return stats.mtime;
  } catch {
    return null;
  }
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "aider",
  slot: "agent" as const,
  description: "Agent plugin: Aider",
  version: "0.1.0",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createAiderAgent(): Agent {
  return {
    name: "aider",
    processName: "aider",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["aider"];

      if (config.permissions === "skip") {
        parts.push("--yes");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.systemPromptFile) {
        parts.push("--system-prompt", `"$(cat ${shellEscape(config.systemPromptFile)})"`);
      } else if (config.systemPrompt) {
        parts.push("--system-prompt", shellEscape(config.systemPrompt));
      }

      if (config.prompt) {
        parts.push("--message", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";
      // Aider doesn't have rich terminal output patterns yet
      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      // Check if process is running first
      if (!session.runtimeHandle) return { state: "exited" };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited" };

      // Process is running - check for activity signals
      if (!session.workspacePath) return null;

      // Check for recent git commits (Aider auto-commits changes)
      const hasCommits = await hasRecentCommits(session.workspacePath);
      if (hasCommits) return { state: "active" };

      // Check chat history file modification time
      const chatMtime = await getChatHistoryMtime(session.workspacePath);
      if (!chatMtime) {
        // No chat history — cannot determine activity
        return null;
      }

      // Classify by age: <30s active, <threshold ready, >threshold idle
      const ageMs = Date.now() - chatMtime.getTime();
      const activeWindowMs = Math.min(30_000, threshold);
      if (ageMs < activeWindowMs) return { state: "active", timestamp: chatMtime };
      if (ageMs < threshold) return { state: "ready", timestamp: chatMtime };
      return { state: "idle", timestamp: chatMtime };
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      return isAgentProcessRunning(handle, "aider");
    },

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      // Aider doesn't have JSONL session files for introspection yet
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAiderAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
