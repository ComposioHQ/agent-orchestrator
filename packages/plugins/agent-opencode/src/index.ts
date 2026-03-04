import {
  shellEscape,
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

const execFileAsync = promisify(execFile);

// =============================================================================
// Terminal Output Patterns for detectActivity
// =============================================================================

/** Classify OpenCode's activity state from terminal output (pure, sync).
 *
 *  Priority order (first match wins):
 *  1. Empty output → idle
 *  2. Last line is a shell/input prompt → idle
 *  3. Tail contains approval/confirmation prompts → waiting_input
 *  4. Tail contains error/blocked indicators → blocked
 *  5. Completion indicators on last line → idle
 *  6. Non-empty output → active (default)
 */
function classifyOpenCodeTerminalOutput(terminalOutput: string): ActivityState {
  // 1. Empty output — can't determine state
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // 2. Shell/input prompt on the last line → idle
  if (/^[❯>$#]\s*$/.test(lastLine)) return "idle";

  // 3. Check the bottom of the buffer for approval/confirmation prompts.
  const tail = lines.slice(-5).join("\n");

  // OpenCode confirmation prompts
  if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";
  if (/\(y\/n\)/i.test(tail)) return "waiting_input";
  if (/approve\?/i.test(tail)) return "waiting_input";
  if (/allow.*tool/i.test(tail) && /\?/.test(tail)) return "waiting_input";
  if (/confirm\?/i.test(tail)) return "waiting_input";
  if (/do you want to proceed\?/i.test(tail)) return "waiting_input";
  if (/press enter to confirm/i.test(tail)) return "waiting_input";
  if (/accept changes\?/i.test(tail)) return "waiting_input";
  if (/apply.*changes?\?/i.test(tail)) return "waiting_input";

  // 4. Check for blocked/error indicators in the tail
  if (/rate limit/i.test(tail)) return "blocked";
  if (/error.*authentication/i.test(tail)) return "blocked";
  if (/api key.*invalid/i.test(tail)) return "blocked";
  if (/token limit exceeded/i.test(tail)) return "blocked";
  if (/context.*window.*exceed/i.test(tail)) return "blocked";
  if (/connection refused/i.test(tail)) return "blocked";
  if (/quota exceeded/i.test(tail)) return "blocked";
  if (/429 Too Many Requests/i.test(tail)) return "blocked";
  if (/retrying in/i.test(tail) && /seconds?/i.test(tail)) return "blocked";
  if (/model.*not (found|available)/i.test(tail)) return "blocked";
  if (/unauthorized/i.test(tail)) return "blocked";
  if (/ECONNREFUSED/i.test(tail)) return "blocked";

  // 5. Completion/done indicators on the last line → idle
  if (/^done\.?$/i.test(lastLine)) return "idle";
  if (/task completed/i.test(lastLine)) return "idle";
  if (/session ended/i.test(lastLine)) return "idle";
  if (/exiting/i.test(lastLine)) return "idle";

  // 6. Default to active — OpenCode is processing.
  return "active";
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "opencode",
  slot: "agent" as const,
  description: "Agent plugin: OpenCode",
  version: "0.1.0",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createOpenCodeAgent(): Agent {
  return {
    name: "opencode",
    processName: "opencode",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["opencode"];

      if (config.prompt) {
        parts.push("run", shellEscape(config.prompt));
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
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
      return classifyOpenCodeTerminalOutput(terminalOutput);
    },

    async getActivityState(session: Session, _readyThresholdMs?: number): Promise<ActivityDetection | null> {
      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      // NOTE: OpenCode stores all session data in a single global SQLite database
      // at ~/.local/share/opencode/opencode.db without per-workspace scoping. When
      // multiple OpenCode sessions run in parallel, database modifications from any
      // session will cause all sessions to appear active. Until OpenCode provides
      // per-workspace session tracking, we return null (unknown) rather than guessing.
      //
      // TODO: Implement proper per-session activity detection when OpenCode supports it.
      return null;
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
          const processRe = /(?:^|\/)opencode(?:\s|$)/;
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

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      // OpenCode doesn't have JSONL session files for introspection yet
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createOpenCodeAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
