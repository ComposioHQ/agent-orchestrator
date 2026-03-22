import {
  shellEscape,
  DEFAULT_READY_THRESHOLD_MS,
  type Agent,
  type AgentLaunchConfig,
  type AgentSessionInfo,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
} from "@composio/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { stat, access } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";

const execFileAsync = promisify(execFile);

// =============================================================================
// Plugin Config
// =============================================================================

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_MODEL = "qwen3:8b";

export interface LocalLlmPluginConfig {
  /** OpenAI-compatible API base URL. Works with Ollama, LM Studio, vLLM, LocalAI, etc.
   *  @default "http://localhost:11434/v1" */
  baseURL?: string;
  /** Model name to pass to the API.
   *  @default "qwen3:8b" */
  model?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build the --model flag value for Aider based on the endpoint URL.
 * Ollama endpoints get the `ollama/` prefix; all other OpenAI-compatible
 * endpoints get the `openai/` prefix so Aider routes them correctly.
 */
function buildModelFlag(baseURL: string, model: string): string {
  if (baseURL.includes("11434") || baseURL.toLowerCase().includes("ollama")) {
    return `ollama/${model}`;
  }
  return `openai/${model}`;
}

// =============================================================================
// Aider Activity Detection Helpers (copied from agent-aider)
// TODO: hasRecentCommits, getChatHistoryMtime, and getActivityState are
// duplicated verbatim from packages/plugins/agent-aider. If a shared
// agent-base (or similar) package is introduced in the future, these helpers
// should be extracted there and imported by both plugins.
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
  name: "local-llm",
  slot: "agent" as const,
  description: "Agent plugin: local/OpenAI-compatible LLM via Aider (Ollama, LM Studio, vLLM, LocalAI, etc.)",
  version: "0.1.0",
  displayName: "Local LLM",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createLocalLlmAgent(pluginConfig: LocalLlmPluginConfig): Agent {
  const configuredBaseURL = pluginConfig.baseURL ?? DEFAULT_BASE_URL;
  const configuredModel = pluginConfig.model ?? DEFAULT_MODEL;

  return {
    name: "local-llm",
    processName: "aider",
    promptDelivery: "post-launch" as const,

    getLaunchCommand(config: AgentLaunchConfig): string {
      // Resolve baseURL and model — per-session agentConfig overrides plugin defaults
      const baseURL = (config.projectConfig.agentConfig?.["baseURL"] as string | undefined)
        ?? configuredBaseURL;
      const model = (config.projectConfig.agentConfig?.["model"] as string | undefined)
        ?? config.model
        ?? configuredModel;

      const modelFlag = buildModelFlag(baseURL, model);

      const parts: string[] = ["aider"];

      // Keep Aider interactive — prompt will be delivered post-launch via tmux send-keys
      parts.push("--yes-always");

      // Route to the correct local model
      parts.push("--model", shellEscape(modelFlag));

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      // Resolve baseURL per-session (agentConfig overrides plugin default)
      const baseURL = (config.projectConfig.agentConfig?.["baseURL"] as string | undefined)
        ?? configuredBaseURL;

      const env: Record<string, string> = {
        AO_SESSION_ID: config.sessionId,
        // Point Aider at the local endpoint
        OPENAI_API_BASE: baseURL,
        // Any non-empty value satisfies Aider's key check for non-OpenAI endpoints
        OPENAI_API_KEY: "local-llm",
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

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      if (!session.workspacePath) return null;

      // Check for recent git commits (Aider auto-commits changes)
      const hasCommits = await hasRecentCommits(session.workspacePath);
      if (hasCommits) return { state: "active" };

      // Check chat history file modification time
      const chatMtime = await getChatHistoryMtime(session.workspacePath);
      if (!chatMtime) {
        return null;
      }

      // Classify by age: <30s active, <threshold ready, >threshold idle
      const ageMs = Date.now() - chatMtime.getTime();
      const activeWindowMs = Math.min(30_000, threshold);
      if (ageMs < activeWindowMs) return { state: "active", timestamp: chatMtime };
      if (ageMs < threshold) return { state: "ready", timestamp: chatMtime };
      return { state: "idle", timestamp: chatMtime };
    },

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      // Aider doesn't expose structured session data for introspection
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(config?: Record<string, unknown>): Agent {
  const pluginConfig: LocalLlmPluginConfig = {
    baseURL: typeof config?.["baseURL"] === "string" ? config["baseURL"] : undefined,
    model: typeof config?.["model"] === "string" ? config["model"] : undefined,
  };
  return createLocalLlmAgent(pluginConfig);
}

export function detect(): boolean {
  try {
    execFileSync("aider", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
