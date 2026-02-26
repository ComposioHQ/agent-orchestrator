import {
  shellEscape,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityState,
  type ActivityDetection,
  type PluginModule,
  type RuntimeHandle,
  type Session,
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MODEL = "codellama";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "ollama",
  slot: "agent" as const,
  description: "Agent plugin: Ollama local models",
  version: "0.1.0",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createOllamaAgent(): Agent {
  return {
    name: "ollama",
    processName: "ollama",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["ollama", "run"];

      const model = config.model ?? DEFAULT_MODEL;
      parts.push(shellEscape(model));

      if (config.prompt) {
        parts.push(shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      // Ollama interactive prompt ">>>" indicates idle/waiting for input
      if (/^>>>?\s*$/.test(lastLine)) return "idle";

      // Check for error patterns
      if (/error|failed|could not/i.test(lastLine)) return "blocked";

      // Check if model has finished generating (ends with empty prompt)
      const tail = lines.slice(-3).join("\n");
      if (/>>>\s*$/.test(tail)) return "idle";

      // Default to active — model is generating output
      return "active";
    },

    async getActivityState(
      session: Session,
      _readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      // Check if process is running first
      if (!session.runtimeHandle) return { state: "exited" };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited" };

      // Ollama doesn't have session files for introspection —
      // activity detection relies on terminal output via detectActivity.
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
          const processRe = /(?:^|\/)ollama(?:\s|$)/;
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
      // Ollama doesn't have session files for introspection
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createOllamaAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
