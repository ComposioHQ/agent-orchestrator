import {
  DEFAULT_READY_THRESHOLD_MS,
  shellEscape,
  type Agent,
  type AgentLaunchConfig,
  type AgentSessionInfo,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
  type AcpxAgentConfig,
} from "@composio/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "bridge.js");

async function isTmuxProcessRunning(handle: RuntimeHandle): Promise<boolean> {
  try {
    const { stdout: ttyOut } = await execFileAsync(
      "tmux",
      ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
      { timeout: 30_000 },
    );
    const ttys = ttyOut
      .trim()
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    if (ttys.length === 0) return false;

    const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
      timeout: 30_000,
    });
    const ttySet = new Set(ttys.map((tty) => tty.replace(/^\/dev\//, "")));
    for (const line of psOut.split("\n")) {
      const cols = line.trimStart().split(/\s+/);
      if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
      const args = cols.slice(2).join(" ");
      if (args.includes("bridge.js") && args.includes("agent-acpx")) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

function createAcpxAgent(): Agent {
  return {
    name: "acpx",
    processName: "node",
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const projectAgentConfig = config.projectConfig.agentConfig as AcpxAgentConfig | undefined;
      const parts = [shellEscape(process.execPath), shellEscape(BRIDGE_PATH)];

      const acpxAgent = projectAgentConfig?.acpxAgent ?? "pi";
      parts.push("--agent", shellEscape(acpxAgent));

      if (config.systemPromptFile) {
        parts.push("--system-prompt-file", shellEscape(config.systemPromptFile));
      } else if (config.systemPrompt) {
        parts.push("--system-prompt", shellEscape(config.systemPrompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {
        AO_SESSION_ID: config.sessionId,
      };

      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";
      return "active";
    },

    async getActivityState(
      session: Session,
      _readyThresholdMs = DEFAULT_READY_THRESHOLD_MS,
    ): Promise<ActivityDetection | null> {
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };

      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) {
        return { state: "exited", timestamp: exitedAt };
      }

      return null;
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          return isTmuxProcessRunning(handle);
        }

        const rawPid = handle.data["pid"];
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error: unknown) {
            if (error instanceof Error && "code" in error && error.code === "EPERM") {
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
      return null;
    },
  };
}

export const manifest = {
  name: "acpx",
  slot: "agent" as const,
  description: "Agent plugin: ACPX bridge",
  version: "0.1.0",
  displayName: "ACPX",
};

export function create(): Agent {
  return createAcpxAgent();
}

export function detect(): boolean {
  try {
    execFileSync("acpx", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
