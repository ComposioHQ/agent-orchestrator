import {
  shellEscape,
  type Agent,
  type AgentLaunchConfig,
  type AgentSessionInfo,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
} from "@composio/ao-core";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// =============================================================================
// Plugin Config
// =============================================================================

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_MODEL = "qwen3:8b";
const OUTPUT_FILE = "local-llm-output.md";

export interface LocalLlmPluginConfig {
  /** OpenAI-compatible API base URL. Works with Ollama, LM Studio, vLLM, LocalAI, etc.
   *  @default "http://localhost:11434/v1" */
  baseURL?: string;
  /** Model name to pass to the API.
   *  @default "qwen3:8b" */
  model?: string;
}

// =============================================================================
// Local LLM Runner Script
// =============================================================================

/** Node.js ES module script that calls any OpenAI-compatible API and handles the task.
 *  Reads configuration from environment variables set by getEnvironment(). */
const LOCAL_LLM_RUNNER_SCRIPT = `#!/usr/bin/env node
// local-llm agent runner — called by the agent-orchestrator local-llm plugin.
// Works with any OpenAI-compatible endpoint: Ollama, LM Studio, vLLM, LocalAI, etc.
// Reads task from AO_PROMPT env var, calls the API, writes output.

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const baseURL = (process.env.AO_LOCAL_LLM_BASE_URL ?? "http://localhost:11434/v1").replace(/\\/$/, "");
const model = process.env.AO_LOCAL_LLM_MODEL ?? "qwen3:8b";
const prompt = process.env.AO_PROMPT ?? "";
const workspacePath = process.env.AO_WORKSPACE_PATH ?? process.cwd();

if (!prompt) {
  console.error("[local-llm] No prompt provided (AO_PROMPT is empty)");
  process.exit(1);
}

console.log(\`[local-llm] Starting task — endpoint: \${baseURL}, model: \${model}\`);
console.log(\`[local-llm] Workspace: \${workspacePath}\`);

let response;
try {
  response = await fetch(\`\${baseURL}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });
} catch (err) {
  console.error(\`[local-llm] Failed to connect to \${baseURL}: \${err instanceof Error ? err.message : String(err)}\`);
  console.error("[local-llm] Make sure the server is running and the baseURL is correct.");
  process.exit(1);
}

if (!response.ok) {
  const body = await response.text().catch(() => "");
  console.error(\`[local-llm] API error: HTTP \${response.status} - \${body}\`);
  process.exit(1);
}

const data = await response.json();
const content = data.choices?.[0]?.message?.content ?? "";

if (!content) {
  console.error("[local-llm] Empty response from model");
  process.exit(1);
}

console.log("\\n[local-llm] Response:\\n");
console.log(content);

// Write output to workspace for reference
try {
  await mkdir(workspacePath, { recursive: true });
  const outputPath = join(workspacePath, "local-llm-output.md");
  const outputContent = \`# Local LLM Task Output\\n\\n## Endpoint\\n\${baseURL}\\n\\n## Model\\n\${model}\\n\\n## Response\\n\\n\${content}\\n\`;
  await writeFile(outputPath, outputContent, "utf-8");
  console.log(\`\\n[local-llm] Output written to: \${outputPath}\`);
} catch (writeErr) {
  console.warn(\`[local-llm] Could not write output file: \${writeErr instanceof Error ? writeErr.message : String(writeErr)}\`);
}

console.log("\\n[local-llm] Task complete.");
`;

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "local-llm",
  slot: "agent" as const,
  description: "Agent plugin: local/OpenAI-compatible LLM (Ollama, LM Studio, vLLM, LocalAI, etc.)",
  version: "0.1.0",
  displayName: "Local LLM",
};

// =============================================================================
// Runner Script Management
// =============================================================================

/** Write the runner script to a persistent location and return its path. */
function ensureRunnerScript(): string {
  const aoDir = join(homedir(), ".ao");
  try {
    mkdirSync(aoDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const scriptPath = join(aoDir, "local-llm-runner.mjs");
  writeFileSync(scriptPath, LOCAL_LLM_RUNNER_SCRIPT, { encoding: "utf-8", mode: 0o755 });
  return scriptPath;
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createLocalLlmAgent(pluginConfig: LocalLlmPluginConfig): Agent {
  const configuredBaseURL = pluginConfig.baseURL ?? DEFAULT_BASE_URL;
  const configuredModel = pluginConfig.model ?? DEFAULT_MODEL;

  return {
    name: "local-llm",
    processName: "node",
    promptDelivery: "inline",

    getLaunchCommand(_config: AgentLaunchConfig): string {
      const scriptPath = ensureRunnerScript();
      return `node ${shellEscape(scriptPath)}`;
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      // Per-session overrides from agentConfig (injected from routing.localLlm at spawn time)
      // take precedence over the plugin-level defaults set at registration.
      const baseURL = (config.projectConfig.agentConfig?.["baseURL"] as string | undefined)
        ?? configuredBaseURL;
      const model = (config.projectConfig.agentConfig?.["model"] as string | undefined)
        ?? config.model
        ?? configuredModel;

      const env: Record<string, string> = {
        AO_SESSION_ID: config.sessionId,
        AO_LOCAL_LLM_BASE_URL: baseURL,
        AO_LOCAL_LLM_MODEL: model,
      };

      if (config.prompt) {
        env["AO_PROMPT"] = config.prompt;
      }

      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      if (config.projectConfig.path) {
        env["AO_WORKSPACE_PATH"] = config.projectConfig.path;
      }

      return env;
    },

    detectActivity(_terminalOutput: string): ActivityState {
      return "active";
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      const rawPid = handle.data["pid"];
      const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
      if (!Number.isFinite(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "EPERM") {
          return true;
        }
        return false;
      }
    },

    async getActivityState(
      session: Session,
      _readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      if (!session.runtimeHandle) {
        return { state: "exited", timestamp: new Date() };
      }
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) {
        return { state: "exited", timestamp: new Date() };
      }
      return { state: "active", timestamp: new Date() };
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const outputPath = join(session.workspacePath, OUTPUT_FILE);
      if (!existsSync(outputPath)) return null;

      try {
        const content = readFileSync(outputPath, "utf-8");
        // Extract just the response section as summary
        const responseMatch = /## Response\n\n([\s\S]+)/.exec(content);
        const summary = responseMatch
          ? responseMatch[1]?.substring(0, 120).trim()
          : content.substring(0, 120).trim();
        return { summary: summary ?? null, agentSessionId: null };
      } catch {
        return null;
      }
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
  // This plugin works with any OpenAI-compatible server.
  // We do a quick reachability check against the default endpoint.
  // If a custom baseURL is configured, detection is best-effort.
  try {
    execFileSync("curl", ["-sf", "--max-time", "2", `${DEFAULT_BASE_URL}/models`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
