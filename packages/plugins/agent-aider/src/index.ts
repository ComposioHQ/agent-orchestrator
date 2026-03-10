import {
  shellEscape,
  DEFAULT_READY_THRESHOLD_MS,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type CostEstimate,
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
// Terminal Output Patterns for detectActivity
// =============================================================================

/** Classify Aider's activity state from terminal output (pure, sync).
 *
 *  Priority order (first match wins):
 *  1. Empty output → idle
 *  2. Last line is a shell/input prompt → idle
 *  3. Tail contains approval/confirmation prompts → waiting_input
 *  4. Tail contains error/blocked indicators → blocked
 *  5. Completion indicators on last line → idle
 *  6. Non-empty output → active (default)
 */
function classifyAiderTerminalOutput(terminalOutput: string): ActivityState {
  // 1. Empty output — can't determine state
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // 2. Shell/input prompt on the last line → idle
  //    Aider shows its prompt as ">" or standard shell prompts when ready.
  if (/^[❯>$#]\s*$/.test(lastLine)) return "idle";
  //    Aider's input prompt pattern: colorized or plain "aider>" or just ">"
  if (/^aider>\s*$/i.test(lastLine)) return "idle";

  // 3. Check the bottom of the buffer for approval/confirmation prompts.
  const tail = lines.slice(-5).join("\n");

  // Aider edit confirmation prompts
  if (/apply.*edit/i.test(tail) && /\?\s*$/.test(tail)) return "waiting_input";
  if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";
  if (/\(Y\/n\)/i.test(tail)) return "waiting_input";
  if (/\(y\/n\)/i.test(tail)) return "waiting_input";
  if (/allow creation of/i.test(tail)) return "waiting_input";
  if (/add.*to the chat\?/i.test(tail)) return "waiting_input";
  if (/drop.*from the chat\?/i.test(tail)) return "waiting_input";
  if (/create.*new file/i.test(tail) && /\?/i.test(tail)) return "waiting_input";
  if (/run.*command/i.test(tail) && /\?/i.test(tail)) return "waiting_input";
  if (/commit this change\?/i.test(tail)) return "waiting_input";

  // 4. Check for blocked/error indicators in the tail
  if (/rate limit/i.test(tail)) return "blocked";
  if (/error.*authentication/i.test(tail)) return "blocked";
  if (/api key.*invalid/i.test(tail)) return "blocked";
  if (/token limit exceeded/i.test(tail)) return "blocked";
  if (/context window/i.test(tail) && /exceed/i.test(tail)) return "blocked";
  if (/connection refused/i.test(tail)) return "blocked";
  if (/quota exceeded/i.test(tail)) return "blocked";
  if (/429 Too Many Requests/i.test(tail)) return "blocked";
  if (/retrying in/i.test(tail) && /seconds?/i.test(tail)) return "blocked";
  if (/model.*not (found|available)/i.test(tail)) return "blocked";
  if (/unauthorized/i.test(tail)) return "blocked";
  if (/ECONNREFUSED/i.test(tail)) return "blocked";

  // 5. Completion/done indicators on the last line → idle
  if (/^Tokens:/i.test(lastLine)) return "idle";
  if (/applied edit/i.test(lastLine) && /to\b/i.test(lastLine)) return "idle";
  if (/commit [0-9a-f]{7}/i.test(lastLine)) return "idle";
  if (/^done\.?$/i.test(lastLine)) return "idle";

  // 6. Default to active — Aider is processing.
  return "active";
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

// =============================================================================
// Aider Session Info Parsing
// =============================================================================

/** Max bytes to read from chat history for summary extraction */
const MAX_CHAT_HISTORY_BYTES = 32_768;

/**
 * Parse Aider's .aider.chat.history.md to extract session info.
 *
 * The file is a Markdown log of the conversation. Format:
 * ```
 * #### <user message>
 *
 * <assistant response>
 * ```
 *
 * We extract:
 * - summary: first user message (truncated) as fallback summary
 * - cost: token usage from "Tokens:" lines if present
 */
async function parseAiderSessionInfo(workspacePath: string): Promise<AgentSessionInfo | null> {
  const chatFile = join(workspacePath, ".aider.chat.history.md");
  let content: string;
  try {
    content = await readFile(chatFile, "utf-8");
  } catch {
    return null;
  }

  if (!content.trim()) return null;

  // Limit how much we parse for performance
  const truncatedContent = content.length > MAX_CHAT_HISTORY_BYTES
    ? content.slice(-MAX_CHAT_HISTORY_BYTES)
    : content;

  // Extract first user message as fallback summary
  // Aider formats user messages as "#### <message>"
  let summary: string | null = null;
  const userMsgMatch = content.match(/^####\s+(.+)$/m);
  if (userMsgMatch) {
    summary = userMsgMatch[1].trim();
    if (summary.length > 120) {
      summary = summary.slice(0, 117) + "...";
    }
  }

  // Extract token usage from "Tokens:" lines
  // Format: "Tokens: 1.2k sent, 3.4k received. Cost: $0.01 message, $0.05 session."
  // or: "Tokens: 12,345 sent, 67,890 received."
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  const tokenLines = truncatedContent.match(/^Tokens:.*$/gm) ?? [];
  for (const line of tokenLines) {
    const sentMatch = line.match(/([\d,.]+)(k)?\s+sent/i);
    const recvMatch = line.match(/([\d,.]+)(k)?\s+received/i);
    if (sentMatch) {
      const val = parseFloat(sentMatch[1].replace(/,/g, ""));
      totalInputTokens += sentMatch[2] ? val * 1000 : val;
    }
    if (recvMatch) {
      const val = parseFloat(recvMatch[1].replace(/,/g, ""));
      totalOutputTokens += recvMatch[2] ? val * 1000 : val;
    }

    // Extract session cost if available
    const sessionCostMatch = line.match(/\$([\d.]+)\s+session/i);
    if (sessionCostMatch) {
      totalCostUsd = parseFloat(sessionCostMatch[1]);
    }
  }

  const cost: CostEstimate | undefined =
    totalInputTokens === 0 && totalOutputTokens === 0
      ? undefined
      : {
          inputTokens: Math.round(totalInputTokens),
          outputTokens: Math.round(totalOutputTokens),
          estimatedCostUsd: totalCostUsd > 0
            ? totalCostUsd
            : (totalInputTokens / 1_000_000) * 3.0 + (totalOutputTokens / 1_000_000) * 15.0,
        };

  return {
    summary,
    summaryIsFallback: true,
    agentSessionId: null,
    cost,
  };
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
      return classifyAiderTerminalOutput(terminalOutput);
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
      return parseAiderSessionInfo(session.workspacePath);
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
