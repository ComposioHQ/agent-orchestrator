import {
  shellEscape,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
} from "@composio/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "copilot",
  slot: "agent" as const,
  description: "Agent plugin: GitHub Copilot CLI",
  version: "0.1.0",
  displayName: "GitHub Copilot",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createCopilotAgent(): Agent {
  return {
    name: "copilot",
    processName: "copilot",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["copilot"];

      // Copilot CLI uses -p flag for prompts
      // Combine systemPrompt and prompt into a single -p flag when both are present
      if (config.systemPromptFile) {
        // Use shell substitution to read from file
        if (config.prompt) {
          parts.push(
            "-p",
            `"$(cat ${shellEscape(config.systemPromptFile)}; printf '\\n\\n'; printf %s ${shellEscape(config.prompt)})"`,
          );
        } else {
          parts.push("-p", `"$(cat ${shellEscape(config.systemPromptFile)})"`);
        }
      } else if (config.systemPrompt) {
        // Combine systemPrompt and prompt with double newline separator
        const combined = config.prompt
          ? `${config.systemPrompt}\n\n${config.prompt}`
          : config.systemPrompt;
        parts.push("-p", shellEscape(combined));
      } else if (config.prompt) {
        parts.push("-p", shellEscape(config.prompt));
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
      // Copilot CLI uses GitHub CLI for authentication
      // Ensure GITHUB_TOKEN or GH_TOKEN is available for non-interactive auth
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const tail = lines.slice(-10).join("\n");

      // Check for Copilot's input prompt patterns
      // Match "copilot> " or "> " at end of output (prompt waiting for input)
      if (/copilot>\s*$/.test(tail)) return "idle";
      if (/(^|\n)>\s*$/.test(tail)) return "idle";

      // Check for approval/permission prompts
      if (/allow this action/i.test(tail)) return "waiting_input";
      if (/approve/i.test(tail) && /y\/n/i.test(tail)) return "waiting_input";

      // Check for autopilot mode indicator
      if (/autopilot/i.test(tail)) return "active";

      // Default to active when there's output
      return "active";
    },

    async getActivityState(
      session: Session,
      _readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      // Process is running - Copilot CLI doesn't have native JSONL/session files
      // like Codex. We rely on process liveness and timing heuristics.
      // Without external signals, we return null to indicate unknown state,
      // allowing the orchestrator to fall back to timing-based detection.
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
          // Match copilot process - use word boundary to avoid false positives
          const processRe = /(?:^|\/)copilot(?:\s|$)/;
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
      // GitHub Copilot CLI doesn't expose session introspection APIs
      // like Codex's JSONL files. Return null for now.
      return null;
    },

    async getRestoreCommand(
      _session: Session,
      _project: ProjectConfig,
    ): Promise<string | null> {
      // Copilot CLI supports session resumption via /resume command
      // but doesn't expose persistent session IDs externally.
      // For now, we fall back to standard launch (no resume support).
      // Future: If Copilot adds session file storage, implement resume here.
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCopilotAgent();
}

export function detect(): boolean {
  try {
    execFileSync("copilot", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
