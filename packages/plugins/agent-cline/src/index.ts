/**
 * Agent Plugin: Cline CLI
 *
 * Supports multi-provider configuration (OpenRouter, Anthropic, OpenAI, etc.)
 * and tracks task activity from Cline's task metadata.
 */

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
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Constants
// =============================================================================

/** Default Cline CLI data directory */
const CLINE_DATA_DIR = ".cline/data";

/** Task metadata filename */
const TASK_METADATA_FILE = "task_metadata.json";

/** API conversation history for getting task context */
const API_CONVERSATION_FILE = "api_conversation_history.json";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "cline",
  slot: "agent" as const,
  description: "Agent plugin: Cline CLI with multi-provider support",
  version: "0.1.0",
};

// =============================================================================
// Types
// =============================================================================

interface ClineTaskMetadata {
  files_in_context?: Array<{
    path: string;
    record_state: "active" | "stale";
    record_source: "read_tool" | "cline_edited" | "user_edited";
    cline_read_date?: number;
    cline_edit_date?: number;
    user_edit_date?: number;
  }>;
  model_usage?: Array<{
    ts: number;
    model_id: string;
    model_provider_id: string;
    mode: "plan" | "act";
  }>;
  environment_history?: Array<{
    ts: number;
    os_name: string;
    os_version: string;
    os_arch: string;
    host_name: string;
    host_version: string;
    cline_version: string;
  }>;
}

interface ClineConversationMessage {
  message?: {
    role: "user" | "assistant" | "system";
    content?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  costUSD?: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get Cline data directory path
 */
function getClineDataDir(): string {
  return join(homedir(), CLINE_DATA_DIR);
}

/**
 * Get the tasks directory
 */
function getTasksDir(): string {
  return join(getClineDataDir(), "tasks");
}

/**
 * Find all task directories, sorted by most recent
 */
async function findAllTaskDirs(): Promise<Array<{ taskId: string; path: string; mtime: number }>> {
  const tasksDir = getTasksDir();

  try {
    const entries = await readdir(tasksDir);
    const taskDirs: Array<{ taskId: string; path: string; mtime: number }> = [];

    for (const entry of entries) {
      const taskPath = join(tasksDir, entry);
      try {
        const stats = await stat(taskPath);
        if (stats.isDirectory()) {
          taskDirs.push({ taskId: entry, path: taskPath, mtime: stats.mtimeMs });
        }
      } catch {
        // Skip inaccessible entries
      }
    }

    // Sort by mtime descending (most recent first)
    taskDirs.sort((a, b) => b.mtime - a.mtime);
    return taskDirs;
  } catch {
    return [];
  }
}

/**
 * Find the most recent task directory for a workspace
 */
async function _findLatestTaskForWorkspace(
  _workspacePath: string,
): Promise<{ taskId: string; path: string } | null> {
  const taskDirs = await findAllTaskDirs();

  // Look for tasks that match the workspace by checking model_usage
  for (const taskDir of taskDirs) {
    try {
      const metadataPath = join(taskDir.path, TASK_METADATA_FILE);
      const content = await readFile(metadataPath, "utf-8");
      const metadata: ClineTaskMetadata = JSON.parse(content);

      // Check if this task has any files_in_context that match the workspace
      // Note: workspace matching would require more sophisticated tracking
      if (metadata.files_in_context && metadata.files_in_context.length > 0) {
        return { taskId: taskDir.taskId, path: taskDir.path };
      }
    } catch {
      // Skip tasks with unreadable metadata
    }
  }

  // Fallback: return the most recent task
  if (taskDirs.length > 0) {
    return { taskId: taskDirs[0].taskId, path: taskDirs[0].path };
  }

  return null;
}

// Keep the function name for future use when workspace matching is needed
const findLatestTaskForWorkspace = _findLatestTaskForWorkspace;

/**
 * Read task metadata
 */
async function readTaskMetadata(taskPath: string): Promise<ClineTaskMetadata | null> {
  try {
    const metadataPath = join(taskPath, TASK_METADATA_FILE);
    const content = await readFile(metadataPath, "utf-8");
    return JSON.parse(content) as ClineTaskMetadata;
  } catch {
    return null;
  }
}

/**
 * Read API conversation history
 */
async function readConversationHistory(taskPath: string): Promise<ClineConversationMessage[]> {
  try {
    const historyPath = join(taskPath, API_CONVERSATION_FILE);
    const content = await readFile(historyPath, "utf-8");
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Check if Cline CLI process is running
 */
async function findClineProcess(handle: RuntimeHandle): Promise<number | null> {
  try {
    // For tmux runtime, get the pane TTY and find cline on it
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
      if (ttys.length === 0) return null;

      const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
        timeout: 30_000,
      });
      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      const processRe = /(?:^|\/)cline(?:\s|$)/;

      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        const args = cols.slice(2).join(" ");
        if (processRe.test(args)) {
          return parseInt(cols[0] ?? "0", 10);
        }
      }
      return null;
    }

    // For process runtime, check if the PID stored in handle data is alive
    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return pid;
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "EPERM") {
          return pid;
        }
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Classify terminal output for activity detection
 */
function classifyTerminalOutput(terminalOutput: string): ActivityState {
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // Check for permission prompts FIRST (before prompt detection)
  // because a prompt character at the end doesn't mean idle if there's
  // a pending permission question above it
  const tail = lines.slice(-5).join("\n");
  if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";
  if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";

  // Check for prompt (Cline uses various prompts)
  if (/^[❯>$#]\s*$/.test(lastLine)) return "idle";

  return "active";
}

/**
 * Extract cost from conversation history
 */
function extractCost(messages: ClineConversationMessage[]): CostEstimate | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;

  for (const msg of messages) {
    if (typeof msg.costUSD === "number") {
      totalCost += msg.costUSD;
    }
    if (msg.usage) {
      inputTokens += msg.usage.input_tokens ?? 0;
      outputTokens += msg.usage.output_tokens ?? 0;
    }
  }

  if (inputTokens === 0 && outputTokens === 0 && totalCost === 0) {
    return undefined;
  }

  return { inputTokens, outputTokens, estimatedCostUsd: totalCost };
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createClineAgent(): Agent {
  return {
    name: "cline",
    processName: "cline",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["cline", "task"];

      // Mode: act (default) or plan
      // Default to act mode for autonomous operation
      parts.push("--act");

      // Model override (if specified)
      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      // Yolo mode for autonomous operation (auto-approve actions)
      parts.push("--yolo");

      // Add system prompt if provided
      if (config.systemPromptFile) {
        // For Cline, we need to pass the prompt differently
        // Cline doesn't have --append-system-prompt, but we can use -p
      }

      if (config.systemPrompt) {
        // Pass system prompt via -p with the prompt
        // Note: This may get truncated for very long prompts
        parts.push("-p", shellEscape(config.systemPrompt));
      } else if (config.prompt) {
        parts.push("-p", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};

      // Set session info for introspection
      env["AO_SESSION_ID"] = config.sessionId;

      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyTerminalOutput(terminalOutput);
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      const pid = await findClineProcess(handle);
      return pid !== null;
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

      // Process is running - try to find activity from task metadata
      if (!session.workspacePath) {
        return null;
      }

      // Find the task for this workspace
      const task = await findLatestTaskForWorkspace(session.workspacePath);
      if (!task) {
        // No task found - assume active
        return { state: "active", timestamp: new Date() };
      }

      const metadata = await readTaskMetadata(task.path);
      if (!metadata) {
        return null;
      }

      // Check model usage to determine activity
      const lastUsage = metadata.model_usage?.[metadata.model_usage.length - 1];
      if (lastUsage) {
        const lastActivityTime = new Date(lastUsage.ts);
        const ageMs = Date.now() - lastActivityTime.getTime();

        // Check for permission prompts by looking at recent file edits
        // (currently unused but available for future enhancements)
        void metadata.files_in_context?.filter((f) => {
          if (f.cline_edit_date) {
            return Date.now() - f.cline_edit_date < 60000; // Last minute
          }
          return false;
        });

        if (lastUsage.mode === "plan") {
          return { state: "waiting_input", timestamp: lastActivityTime };
        }

        // If recently active (< threshold), it's active or ready
        if (ageMs < threshold) {
          return { state: "active", timestamp: lastActivityTime };
        }

        return { state: "idle", timestamp: lastActivityTime };
      }

      return { state: "active", timestamp: new Date() };
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const task = await findLatestTaskForWorkspace(session.workspacePath);
      if (!task) return null;

      const metadata = await readTaskMetadata(task.path);
      const conversation = await readConversationHistory(task.path);

      if (!metadata) return null;

      // Extract model info (currently unused but available for future enhancements)
      void metadata.model_usage?.[metadata.model_usage.length - 1];

      // Build summary from recent file activity
      const recentFiles = metadata.files_in_context?.slice(0, 5) || [];
      let summary: string | null = null;

      if (recentFiles.length > 0) {
        const fileNames = recentFiles.map((f) => f.path.split("/").pop()).join(", ");
        summary = `Working on: ${fileNames}`;
      }

      return {
        summary,
        summaryIsFallback: !summary,
        agentSessionId: task.taskId,
        cost: extractCost(conversation),
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.agentInfo?.agentSessionId) {
        // Try to find a task for this workspace
        const task = session.workspacePath
          ? await findLatestTaskForWorkspace(session.workspacePath)
          : null;
        if (!task) return null;
        session.agentInfo = { agentSessionId: task.taskId, summary: null };
      }

      const taskId = session.agentInfo?.agentSessionId;
      if (!taskId) return null;

      const parts: string[] = ["cline", "task"];

      // Resume existing task
      parts.push("-T", shellEscape(taskId));

      // Add model override if specified
      if (project.agentConfig?.model) {
        parts.push("--model", shellEscape(project.agentConfig.model as string));
      }

      // Yolo mode for autonomous operation
      parts.push("--yolo");

      return parts.join(" ");
    },

    async setupWorkspaceHooks(
      _workspacePath: string,
      _config: WorkspaceHooksConfig,
    ): Promise<void> {
      // Cline doesn't have a hooks mechanism like Claude Code
      // We rely on polling the task metadata directory for activity
      // No setup needed
    },

    async postLaunchSetup(_session: Session): Promise<void> {
      // No post-launch setup needed for Cline
      // Task metadata is automatically created when cline task runs
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createClineAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
