import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  readLastJsonlEntry,
  normalizeAgentPermissionMode,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityState,
  type ActivityDetection,
  type CostEstimate,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
// Copilot Session Discovery
// =============================================================================

/** Copilot session state directory: ~/.copilot/session-state/ */
const COPILOT_SESSIONS_DIR = join(homedir(), ".copilot", "session-state");

/** TTL for session directory cache (ms). Prevents redundant filesystem scans
 *  when getActivityState and getSessionInfo are called in the same refresh cycle. */
const SESSION_DIR_CACHE_TTL_MS = 30_000;

/** Module-level session directory cache shared across the agent instance lifetime.
 *  Keyed by workspace path, stores the resolved session dir and an expiry timestamp. */
const sessionDirCache = new Map<string, { dir: string | null; expiry: number }>();

/** @internal Clear the session directory cache. Exported for testing only. */
export function _resetSessionDirCache(): void {
  sessionDirCache.clear();
}

interface CopilotWorkspaceYaml {
  id?: string;
  cwd?: string;
  git_root?: string;
  summary?: string;
  updated_at?: string;
}

/**
 * Parse a workspace.yaml file from a Copilot session directory.
 * Copilot writes simple key: value YAML — we parse it without a YAML library.
 */
function parseWorkspaceYaml(content: string): CopilotWorkspaceYaml {
  const result: CopilotWorkspaceYaml = {};
  for (const line of content.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "id") result.id = value;
    else if (key === "cwd") result.cwd = value;
    else if (key === "git_root") result.git_root = value;
    else if (key === "summary") result.summary = value;
    else if (key === "updated_at") result.updated_at = value;
  }
  return result;
}

/**
 * Find the Copilot session directory whose workspace.yaml cwd or git_root
 * matches the given workspace path. Returns the most recently modified match.
 * Results are cached to avoid scanning every poll cycle.
 */
async function findCopilotSessionDir(workspacePath: string): Promise<string | null> {
  const cached = sessionDirCache.get(workspacePath);
  if (cached && Date.now() < cached.expiry) {
    return cached.dir;
  }

  const result = await scanForSessionDir(workspacePath);
  sessionDirCache.set(workspacePath, {
    dir: result,
    expiry: Date.now() + SESSION_DIR_CACHE_TTL_MS,
  });
  return result;
}

async function scanForSessionDir(workspacePath: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(COPILOT_SESSIONS_DIR);
  } catch {
    return null;
  }

  let bestMatch: { dir: string; mtime: number } | null = null;

  for (const entry of entries) {
    const sessionDir = join(COPILOT_SESSIONS_DIR, entry);
    const yamlPath = join(sessionDir, "workspace.yaml");

    try {
      const yamlContent = await readFile(yamlPath, "utf-8");
      const parsed = parseWorkspaceYaml(yamlContent);

      if (parsed.cwd === workspacePath || parsed.git_root === workspacePath) {
        const s = await stat(sessionDir);
        if (!bestMatch || s.mtimeMs > bestMatch.mtime) {
          bestMatch = { dir: sessionDir, mtime: s.mtimeMs };
        }
      }
    } catch {
      // Skip sessions with missing/unreadable workspace.yaml
    }
  }

  return bestMatch?.dir ?? null;
}

// =============================================================================
// events.jsonl Parsing (for getSessionInfo cost tracking)
// =============================================================================

interface CopilotEventLine {
  type?: string;
  data?: {
    content?: string;
    sessionId?: string;
    outputTokens?: number;
    totalPremiumRequests?: number;
    modelMetrics?: Record<
      string,
      {
        requests?: { count?: number; cost?: number };
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          reasoningTokens?: number;
        };
      }
    >;
    shutdownType?: string;
  };
}

/**
 * Parse the events.jsonl file and extract cost/usage data.
 * Reads only the tail to handle large files efficiently.
 */
async function parseEventsJsonlTail(
  filePath: string,
  maxBytes = 131_072,
): Promise<CopilotEventLine[]> {
  let content: string;
  let offset: number;
  try {
    const { size = 0 } = await stat(filePath);
    offset = Math.max(0, size - maxBytes);
    if (offset === 0) {
      content = await readFile(filePath, "utf-8");
    } else {
      const { open } = await import("node:fs/promises");
      const handle = await open(filePath, "r");
      try {
        const length = size - offset;
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        content = buffer.toString("utf-8");
      } finally {
        await handle.close();
      }
    }
  } catch {
    return [];
  }

  const firstNewline = content.indexOf("\n");
  const safeContent = offset > 0 && firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
  const lines: CopilotEventLine[] = [];
  for (const line of safeContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        lines.push(parsed as CopilotEventLine);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

/** Extract cost/usage from parsed events.jsonl lines */
function extractCopilotCost(lines: CopilotEventLine[]): CostEstimate | undefined {
  // Prefer the session.shutdown event with aggregate modelMetrics
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.type === "session.shutdown" && line.data?.modelMetrics) {
      let inputTokens = 0;
      let outputTokens = 0;

      for (const metrics of Object.values(line.data.modelMetrics)) {
        const usage = metrics.usage;
        if (usage) {
          inputTokens += (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
          outputTokens += (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0);
        }
      }

      if (inputTokens > 0 || outputTokens > 0) {
        // Copilot is subscription-based — report token counts but no USD cost
        return { inputTokens, outputTokens, estimatedCostUsd: 0 };
      }
    }
  }

  // Fallback: sum outputTokens from individual assistant.message events
  let totalOutputTokens = 0;
  for (const line of lines) {
    if (
      line?.type === "assistant.message" &&
      typeof line.data?.outputTokens === "number"
    ) {
      totalOutputTokens += line.data.outputTokens;
    }
  }

  if (totalOutputTokens > 0) {
    return { inputTokens: 0, outputTokens: totalOutputTokens, estimatedCostUsd: 0 };
  }

  return undefined;
}

// =============================================================================
// Process Detection
// =============================================================================

/**
 * TTL cache for `ps -eo pid,tty,args` output. Without this, listing N sessions
 * would spawn N concurrent `ps` processes. The cache ensures `ps` is called at
 * most once per TTL window regardless of how many sessions are being enriched.
 */
let psCache: { output: string; timestamp: number; promise?: Promise<string> } | null = null;
const PS_CACHE_TTL_MS = 5_000;

/** Reset the ps cache. Exported for testing only. */
export function resetPsCache(): void {
  psCache = null;
}

async function getCachedProcessList(): Promise<string> {
  const now = Date.now();
  if (psCache && now - psCache.timestamp < PS_CACHE_TTL_MS) {
    if (psCache.promise) return psCache.promise;
    return psCache.output;
  }

  const promise = execFileAsync("ps", ["-eo", "pid,tty,args"], {
    timeout: 5_000,
  }).then(({ stdout }) => {
    if (psCache?.promise === promise) {
      psCache = { output: stdout, timestamp: Date.now() };
    }
    return stdout;
  });

  psCache = { output: "", timestamp: now, promise };

  try {
    return await promise;
  } catch {
    if (psCache?.promise === promise) {
      psCache = null;
    }
    return "";
  }
}

/**
 * Check if a process named "copilot" is running in the given runtime handle's context.
 * Copilot is a native binary — it appears directly as "copilot" in ps output.
 */
async function findCopilotProcess(handle: RuntimeHandle): Promise<number | null> {
  try {
    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync(
        "tmux",
        ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
        { timeout: 5_000 },
      );
      const ttys = ttyOut
        .trim()
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      if (ttys.length === 0) return null;

      const psOut = await getCachedProcessList();
      if (!psOut) return null;

      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      // Match "copilot" as a word boundary — prevents false positives on
      // names like "copilot-something" or paths that merely contain the substring.
      const processRe = /(?:^|\/)copilot(?:\s|$)/;
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

// =============================================================================
// Terminal Output Patterns for detectActivity
// =============================================================================

/** Classify Copilot CLI's activity state from terminal output (pure, sync). */
function classifyTerminalOutput(terminalOutput: string): ActivityState {
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // If the prompt is visible, the agent is idle
  if (/^[>$#]\s*$/.test(lastLine)) return "idle";

  // Check the bottom of the buffer for Copilot's TUI permission prompts
  const tail = lines.slice(-5).join("\n");
  if (/Do you want to allow this\?/i.test(tail)) return "waiting_input";
  if (/Do you trust the files in this folder\?/i.test(tail)) return "waiting_input";
  if (/\u2191\u2193 to navigate/i.test(tail)) return "waiting_input";

  // Everything else is active
  return "active";
}

// =============================================================================
// Copilot events.jsonl Event Type Mapping
// =============================================================================

/**
 * Map a Copilot events.jsonl event type to an activity state.
 * Returns null for unknown types (caller handles default).
 */
function mapCopilotEventType(
  eventType: string,
): "active" | "ready" | "blocked" | "exited" | null {
  switch (eventType) {
    // Active states — agent is working
    case "session.start":
    case "session.model_change":
    case "user.message":
    case "assistant.turn_start":
    case "tool.execution_start":
      return "active";

    // Ready states — turn completed, waiting for next input
    case "assistant.turn_end":
    case "assistant.message":
      return "ready";

    // Exited — session ended
    case "session.shutdown":
      return "exited";

    // tool.execution_complete with success=false maps to blocked,
    // but that requires inspecting the data field, not just the type.
    // Handled separately in getActivityState.

    default:
      return null;
  }
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createCopilotAgent(): Agent {
  return {
    name: "copilot",
    processName: "copilot",
    promptDelivery: "inline",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["copilot"];

      const permissionMode = normalizeAgentPermissionMode(config.permissions);
      if (permissionMode === "permissionless") {
        parts.push("--allow-all", "--no-ask-user");
      } else if (permissionMode === "auto-edit") {
        parts.push("--allow-tool=write", "--allow-tool='shell(git:*)'");
      } else if (permissionMode === "suggest") {
        parts.push("--mode", "plan");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      // Prevent update prompts during agent execution
      parts.push("--no-auto-update");

      if (config.prompt) {
        // Use -i to stay interactive after executing the prompt
        parts.push("-i", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};

      env["AO_SESSION_ID"] = config.sessionId;

      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // Prevent auto-update prompts during execution
      env["COPILOT_AUTO_UPDATE"] = "false";

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyTerminalOutput(terminalOutput);
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      const pid = await findCopilotProcess(handle);
      return pid !== null;
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      // 1. PROCESS CHECK — always first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      if (!session.workspacePath) return null;

      // 2. ACTIONABLE STATES — check AO activity JSONL for waiting_input/blocked
      //    Copilot's native events.jsonl does NOT contain waiting_input events.
      //    Permission prompts only appear in terminal output (TUI dialogs).
      const activityResult = await readLastActivityEntry(session.workspacePath);
      const activityState = checkActivityLogState(activityResult);
      if (activityState) return activityState;

      // 3. NATIVE SIGNAL — read last entry from Copilot's events.jsonl
      const sessionDir = await findCopilotSessionDir(session.workspacePath);
      if (sessionDir) {
        const eventsPath = join(sessionDir, "events.jsonl");
        const entry = await readLastJsonlEntry(eventsPath);
        if (entry) {
          const ageMs = Date.now() - entry.modifiedAt.getTime();
          const timestamp = entry.modifiedAt;
          const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);

          // Check for tool.execution_complete with failure (blocked)
          if (entry.lastType === "tool.execution_complete") {
            // Cannot inspect data.success from readLastJsonlEntry — treat as
            // potentially active (tool just finished) with age decay
            if (ageMs <= activeWindowMs) return { state: "active", timestamp };
            return { state: ageMs > threshold ? "idle" : "ready", timestamp };
          }

          const mappedState = entry.lastType
            ? mapCopilotEventType(entry.lastType)
            : null;

          if (mappedState === "exited") {
            return { state: "exited", timestamp };
          }

          if (mappedState === "active") {
            if (ageMs <= activeWindowMs) return { state: "active", timestamp };
            return { state: ageMs > threshold ? "idle" : "ready", timestamp };
          }

          if (mappedState === "ready") {
            return { state: ageMs > threshold ? "idle" : "ready", timestamp };
          }

          // Unknown event type — use age-based classification
          if (ageMs <= activeWindowMs) return { state: "active", timestamp };
          return { state: ageMs > threshold ? "idle" : "ready", timestamp };
        }
      }

      // 4. JSONL ENTRY FALLBACK — use AO activity JSONL with age-based decay
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

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const sessionDir = await findCopilotSessionDir(session.workspacePath);
      if (!sessionDir) return null;

      // Read workspace.yaml for summary and session ID
      const yamlPath = join(sessionDir, "workspace.yaml");
      let yaml: CopilotWorkspaceYaml;
      try {
        const yamlContent = await readFile(yamlPath, "utf-8");
        yaml = parseWorkspaceYaml(yamlContent);
      } catch {
        return null;
      }

      // Extract session ID from workspace.yaml id field, falling back to dir name
      const agentSessionId =
        yaml.id ?? sessionDir.split("/").pop() ?? null;

      // Read events.jsonl for cost tracking
      const eventsPath = join(sessionDir, "events.jsonl");
      const events = await parseEventsJsonlTail(eventsPath);
      const cost = extractCopilotCost(events);

      // Summary from workspace.yaml
      const summary = yaml.summary ?? null;

      return {
        summary,
        summaryIsFallback: !yaml.summary,
        agentSessionId,
        cost,
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      const sessionDir = await findCopilotSessionDir(session.workspacePath);
      if (!sessionDir) return null;

      // Read workspace.yaml for the session UUID
      const yamlPath = join(sessionDir, "workspace.yaml");
      let yaml: CopilotWorkspaceYaml;
      try {
        const yamlContent = await readFile(yamlPath, "utf-8");
        yaml = parseWorkspaceYaml(yamlContent);
      } catch {
        return null;
      }

      const sessionId = yaml.id;
      if (!sessionId) return null;

      const parts: string[] = ["copilot", `--resume=${shellEscape(sessionId)}`];

      const permissionMode = normalizeAgentPermissionMode(project.agentConfig?.permissions);
      if (permissionMode === "permissionless") {
        parts.push("--allow-all", "--no-ask-user");
      } else if (permissionMode === "auto-edit") {
        parts.push("--allow-tool=write", "--allow-tool='shell(git:*)'");
      } else if (permissionMode === "suggest") {
        parts.push("--mode", "plan");
      }

      if (project.agentConfig?.model) {
        parts.push("--model", shellEscape(project.agentConfig.model as string));
      }

      parts.push("--no-auto-update");

      return parts.join(" ");
    },

    async setupWorkspaceHooks(
      _workspacePath: string,
      _config: WorkspaceHooksConfig,
    ): Promise<void> {
      // PATH wrappers are installed by session-manager for all agents.
      // Copilot discovers AGENTS.md from .ao/ (written by setupPathWrapperWorkspace).
    },

    async postLaunchSetup(_session: Session): Promise<void> {
      // PATH wrappers are re-ensured by session-manager.
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
    execFileSync("copilot", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
