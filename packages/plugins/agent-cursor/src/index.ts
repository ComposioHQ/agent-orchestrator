import {
  shellEscape,
  normalizeAgentPermissionMode,
  buildAgentPath,
  setupPathWrapperWorkspace,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  PREFERRED_GH_PATH,
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@composio/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { stat, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";

const execFileAsync = promisify(execFile);

// =============================================================================
// Cursor Activity Detection Helpers
// =============================================================================

/**
 * Check if Cursor has made recent commits (within last 60 seconds).
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
 * Get modification time of Cursor session file if it exists.
 * Cursor may create a .cursor directory with session data.
 *
 * Checks .cursor/chat.md file mtime (which tracks actual Cursor writes),
 * falling back to directory mtime only if the file doesn't exist.
 */
async function getCursorSessionMtime(workspacePath: string): Promise<Date | null> {
  try {
    const cursorDir = join(workspacePath, ".cursor");
    const chatFile = join(cursorDir, "chat.md");

    // First try to stat the chat file (preferred - tracks actual writes)
    try {
      const stats = await stat(chatFile);
      return stats.mtime;
    } catch {
      // Fall back to directory mtime if chat file doesn't exist
      await access(cursorDir, constants.R_OK);
      const stats = await stat(cursorDir);
      return stats.mtime;
    }
  } catch {
    return null;
  }
}

// =============================================================================
// Session Info Helpers
// =============================================================================

/**
 * Extract a summary from Cursor's session data if available.
 * This is a best-effort approach as Cursor's internal format may vary.
 */
async function extractCursorSummary(workspacePath: string): Promise<string | null> {
  try {
    // Try to read from .cursor directory if it exists
    const cursorDir = join(workspacePath, ".cursor");
    const chatFile = join(cursorDir, "chat.md");

    try {
      const content = await readFile(chatFile, "utf-8");
      // Extract first meaningful line
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0 && !trimmed.startsWith("#")) {
          return trimmed.length > 120 ? trimmed.substring(0, 120) + "..." : trimmed;
        }
      }
    } catch {
      // Chat file doesn't exist, continue
    }
  } catch {
    // .cursor directory doesn't exist
  }
  return null;
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "cursor",
  slot: "agent" as const,
  description: "Agent plugin: Cursor Agent CLI",
  version: "0.1.0",
  displayName: "Cursor",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createCursorAgent(): Agent {
  return {
    name: "cursor",
    processName: "agent",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["agent"];

      const permissionMode = normalizeAgentPermissionMode(config.permissions);
      if (permissionMode === "permissionless" || permissionMode === "auto-edit") {
        // Cursor uses --force (or --yolo alias) for automatic approval
        // --sandbox disabled: Skip workspace trust prompts entirely
        // --approve-mcps: Auto-approve MCP servers
        // Note: --trust only works in headless mode (with --print), so we use --sandbox disabled instead
        parts.push("--force", "--sandbox", "disabled", "--approve-mcps");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      // Note: Cursor agent doesn't have --system or --prompt flags
      // System prompts would need to be passed differently (TBD)
      // Prompt is passed as positional argument at the end
      // Use -- separator to prevent prompts starting with - from being parsed as flags

      if (config.prompt) {
        parts.push("--", shellEscape(config.prompt));
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

      // Prepend ~/.ao/bin to PATH so our gh/git wrappers intercept commands.
      env["PATH"] = buildAgentPath(process.env["PATH"]);
      env["GH_PATH"] = PREFERRED_GH_PATH;

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      // Cursor agent's input prompt — agent is idle, waiting for user command
      if (/^[>$#]\s*$/.test(lastLine)) return "idle";
      // Cursor agent-specific prompt patterns
      if (/^agent>\s*$/.test(lastLine)) return "idle";
      if (/^\[agent\]\s*$/.test(lastLine)) return "idle";

      // Check the last few lines for permission/confirmation prompts
      const tail = lines.slice(-5).join("\n");
      if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
      if (/Approve.*changes\?/i.test(tail)) return "waiting_input";
      if (/Continue\?/i.test(tail)) return "waiting_input";
      if (/\[Yes\].*\[No\]/i.test(tail)) return "waiting_input";
      if (/proceed\?/i.test(tail)) return "waiting_input";
      if (/Press Enter to continue/i.test(tail)) return "waiting_input";

      // Note: "blocked" detection removed — compiler errors, test failures, and linter
      // messages are extremely common in normal tool output. Unlike Claude Code (which
      // has native JSONL with rich "error" types), terminal-based detection can't
      // distinguish between actionable agent errors and normal tool output.
      // If Cursor CLI provides native JSONL in the future, blocked detection can be
      // added to getActivityState() based on JSONL entry types.

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

      // 1. Check AO activity JSONL first (written by recordActivity from terminal output).
      //    This is the only source of waiting_input/blocked states for Cursor.
      const activityResult = await readLastActivityEntry(session.workspacePath);
      const activityState = checkActivityLogState(activityResult);
      if (activityState) return activityState;

      // 2. Fallback: check for recent git commits (Cursor may auto-commit changes)
      const hasCommits = await hasRecentCommits(session.workspacePath);
      if (hasCommits) return { state: "active" };

      // 3. Fallback: check Cursor session directory modification time
      const sessionMtime = await getCursorSessionMtime(session.workspacePath);
      if (sessionMtime) {
        const ageMs = Date.now() - sessionMtime.getTime();
        const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
        if (ageMs <= activeWindowMs) return { state: "active", timestamp: sessionMtime };
        if (ageMs <= threshold) return { state: "ready", timestamp: sessionMtime };
        return { state: "idle", timestamp: sessionMtime };
      }

      // 4. Fallback: use JSONL entry with age-based decay when session data is unavailable.
      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
      const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
      if (fallback) return fallback;

      return null;
    },

    async recordActivity(session: Session, terminalOutput: string): Promise<void> {
      if (!session.workspacePath) return;
      await recordTerminalActivity(session.workspacePath, terminalOutput, (output: string) =>
        this.detectActivity(output),
      );
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
          // Match "agent" binary (Cursor's CLI command name)
          // Use word boundary to avoid matching "agent-orchestrator" etc.
          const processRe = /(?:^|\/)\bagent\b(?:\s|$)/;
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

      const summary = await extractCursorSummary(session.workspacePath);
      if (!summary) return null;

      return {
        summary,
        summaryIsFallback: true,
        agentSessionId: null,
        // Cursor doesn't expose token/cost data via CLI
      };
    },

    // Cursor doesn't support session resume — return null so caller falls back to getLaunchCommand
    async getRestoreCommand(_session: Session, _project: ProjectConfig): Promise<string | null> {
      return null;
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupPathWrapperWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await setupPathWrapperWorkspace(session.workspacePath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCursorAgent();
}

export function detect(): boolean {
  try {
    // Check for Cursor-specific output to avoid false positives with generic "agent" commands
    const result = execFileSync("agent", ["--version"], { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
    // Cursor's agent binary should include "cursor" or "agent" in version output
    // If version output is empty or doesn't match expected pattern, return false
    const output = result.toString().toLowerCase();
    return output.includes("cursor") || output.includes("agent");
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
