import {
  shellEscape,
  DEFAULT_READY_THRESHOLD_MS,
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
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

// =============================================================================
// Cline Data Paths
// =============================================================================

/** Default Cline data directory. Overridable via CLINE_DIR env var. */
function getClineDataDir(): string {
  return process.env["CLINE_DIR"] ?? join(homedir(), ".cline", "data");
}

/** Cline tasks directory: ~/.cline/data/tasks/ */
function getClineTasksDir(): string {
  return join(getClineDataDir(), "tasks");
}

// =============================================================================
// Cline Task Metadata Parsing
// =============================================================================

interface ClineTaskMetadata {
  id: string;
  summary: string | null;
  totalCost: number | null;
  updatedAt: Date | null;
}

/**
 * Find the most recently modified Cline task directory.
 * Tasks are stored in ~/.cline/data/tasks/{taskId}/
 *
 * WARNING: Cline stores all tasks in a single global directory without
 * per-workspace or per-session scoping. When multiple Cline sessions run
 * in parallel, this may return a task from a different session. We mitigate
 * this by optionally accepting a session creation time to filter tasks that
 * were modified after the session started.
 */
async function findLatestTask(sessionCreatedAt?: Date): Promise<ClineTaskMetadata | null> {
  try {
    const tasksDir = getClineTasksDir();
    const entries = await readdir(tasksDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 0) return null;

    // Find most recently modified task directory
    let latestDir: string | null = null;
    let latestMtime = 0;

    const sessionStartMs = sessionCreatedAt?.getTime() ?? 0;
    for (const dir of dirs) {
      try {
        const dirPath = join(tasksDir, dir.name);
        const stats = await stat(dirPath);
        // Skip tasks modified before this session started (multi-session mitigation)
        if (sessionStartMs > 0 && stats.mtimeMs < sessionStartMs) continue;
        if (stats.mtimeMs > latestMtime) {
          latestMtime = stats.mtimeMs;
          latestDir = dir.name;
        }
      } catch {
        continue;
      }
    }

    if (!latestDir) return null;

    // Try to read task metadata
    const metaPath = join(tasksDir, latestDir, "task_metadata.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(raw) as Record<string, unknown>;
      return {
        id: latestDir,
        summary: typeof meta["task"] === "string" ? meta["task"].slice(0, 120) : null,
        totalCost: typeof meta["totalCost"] === "number" ? meta["totalCost"] : null,
        updatedAt: latestMtime ? new Date(latestMtime) : null,
      };
    } catch {
      // Metadata file may not exist yet
      return {
        id: latestDir,
        summary: null,
        totalCost: null,
        updatedAt: latestMtime ? new Date(latestMtime) : null,
      };
    }
  } catch {
    return null;
  }
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "cline",
  slot: "agent" as const,
  description: "Agent plugin: Cline CLI",
  version: "0.1.0",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createClineAgent(): Agent {
  return {
    name: "cline",
    processName: "cline",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["cline"];

      // Autonomous mode: --yolo auto-approves all actions
      if (config.permissions === "skip") {
        parts.push("--yolo");
      }

      // Default to act mode for non-interactive use
      parts.push("--act");

      if (config.model) {
        parts.push("-m", shellEscape(config.model));
      }

      if (config.prompt) {
        parts.push(shellEscape(config.prompt));
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
      if (!terminalOutput.trim()) return "idle";

      const lastChunk = terminalOutput.slice(-2000);

      // Cline asking for user input / confirmation
      if (/\bDo you want to proceed\b/i.test(lastChunk)) return "waiting_input";
      if (/\bApprove\b.*\?\s*$/m.test(lastChunk)) return "waiting_input";
      if (/\[Y\/n\]/i.test(lastChunk)) return "waiting_input";

      // Error / blocked states
      if (/\bError:\s/i.test(lastChunk)) return "blocked";
      if (/\bAPI Error\b/i.test(lastChunk)) return "blocked";
      if (/\brate limit/i.test(lastChunk)) return "blocked";
      if (/\bAuthentication failed\b/i.test(lastChunk)) return "blocked";

      // Task completion indicators
      if (/\bTask completed\b/i.test(lastChunk)) return "idle";

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

      // Check latest task metadata for activity signals
      const task = await findLatestTask(session.createdAt);
      if (!task?.updatedAt) return null;

      // Classify by age
      const ageMs = Date.now() - task.updatedAt.getTime();
      const activeWindowMs = Math.min(30_000, threshold);
      if (ageMs < activeWindowMs) return { state: "active", timestamp: task.updatedAt };
      if (ageMs < threshold) return { state: "ready", timestamp: task.updatedAt };
      return { state: "idle", timestamp: task.updatedAt };
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
          const processRe = /(?:^|\/)cline(?:\s|$)/;
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
      const task = await findLatestTask(session.createdAt);
      if (!task) return null;

      return {
        summary: task.summary,
        agentSessionId: task.id,
        cost: task.totalCost !== null && task.totalCost !== undefined
          ? { inputTokens: 0, outputTokens: 0, estimatedCostUsd: task.totalCost }
          : undefined,
      };
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
