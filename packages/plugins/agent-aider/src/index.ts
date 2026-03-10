import {
  shellEscape,
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
import { stat, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";

const execFileAsync = promisify(execFile);

function normalizePermissionMode(mode: string | undefined): "permissionless" | "default" | "auto-edit" | "suggest" | undefined {
  if (!mode) return undefined;
  if (mode === "skip") return "permissionless";
  if (mode === "permissionless" || mode === "default" || mode === "auto-edit" || mode === "suggest") {
    return mode;
  }
  return undefined;
}

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

/**
 * Extract a summary from Aider's chat history file (.aider.chat.history.md).
 * The file uses markdown with `#### <role>` headers separating messages.
 * Returns the first line of the last assistant message as the summary.
 */
async function extractSummaryFromChatHistory(
  workspacePath: string,
): Promise<{ summary: string; isFallback: boolean } | null> {
  const chatFile = join(workspacePath, ".aider.chat.history.md");
  let content: string;
  try {
    content = await readFile(chatFile, "utf-8");
  } catch {
    return null;
  }

  if (!content.trim()) return null;

  // Split into sections by role headers (#### user, #### assistant)
  // Walk backwards to find the last assistant message
  const lines = content.split("\n");
  let lastAssistantStart = -1;
  let lastAssistantEnd = lines.length;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (/^#{1,4}\s+(assistant|ASSISTANT)/i.test(line)) {
      lastAssistantStart = i + 1;
      break;
    }
    // If we hit another header before finding assistant, update the end boundary
    if (/^#{1,4}\s+(user|USER|system|SYSTEM)/i.test(line)) {
      lastAssistantEnd = i;
    }
  }

  if (lastAssistantStart === -1) {
    // No assistant message found — try to use the first user message as fallback
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^#{1,4}\s+(user|USER)/i.test(line)) {
        // Gather content until the next section header
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (/^#{1,4}\s+/i.test(nextLine)) break;
          if (nextLine) {
            return { summary: nextLine.slice(0, 120), isFallback: true };
          }
        }
        break;
      }
    }
    return null;
  }

  // Extract the assistant message content, skipping code blocks entirely
  const rawLines = lines.slice(lastAssistantStart, lastAssistantEnd);
  const assistantLines: string[] = [];
  let inCodeBlock = false;
  for (const l of rawLines) {
    const trimmed = l.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock && trimmed) {
      assistantLines.push(trimmed);
    }
  }

  if (assistantLines.length === 0) return null;

  return { summary: assistantLines[0].slice(0, 120), isFallback: false };
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

      const permissionMode = normalizePermissionMode(config.permissions);
      if (permissionMode === "permissionless" || permissionMode === "auto-edit") {
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

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";
      const tail = lines.slice(-5).join("\n");

      // Aider's input prompt — waiting for user input
      if (/^aider\s*>\s*$/i.test(lastLine)) return "ready";
      if (/^>\s*$/.test(lastLine)) return "ready";

      // Permission/confirmation prompts
      if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
      if (/Allow edits to/i.test(tail)) return "waiting_input";
      if (/Add .+ to the chat\?/i.test(tail)) return "waiting_input";
      if (/Create new file/i.test(tail)) return "waiting_input";

      // Error patterns
      if (/^Error:/i.test(lastLine)) return "blocked";
      if (/API Error/i.test(tail)) return "blocked";
      if (/rate limit/i.test(tail)) return "blocked";

      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

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
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: 30_000 },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: 30_000,
          });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)aider(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        }

        const rawPid = handle.data["pid"];
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (err: unknown) {
            if (err instanceof Error && "code" in err && err.code === "EPERM") {
              return true;
            }
            return false;
          }
        }

        return false;
      } catch {
        return false;
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const result = await extractSummaryFromChatHistory(session.workspacePath);
      return {
        summary: result?.summary ?? null,
        summaryIsFallback: result?.isFallback ?? false,
        agentSessionId: null, // Aider doesn't have persistent session IDs
      };
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
