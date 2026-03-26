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
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { stat, access } from "node:fs/promises";
import { basename, join } from "node:path";
import { constants } from "node:fs";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

// =============================================================================
// Permission Mode Normalization
// =============================================================================

function normalizePermissionMode(
  mode: string | undefined,
): "permissionless" | "default" | "auto-edit" | "suggest" | undefined {
  if (!mode) return undefined;
  if (mode === "skip") return "permissionless";
  if (
    mode === "permissionless" ||
    mode === "default" ||
    mode === "auto-edit" ||
    mode === "suggest"
  ) {
    return mode;
  }
  return undefined;
}

// =============================================================================
// Cursor Activity Detection Helpers
// =============================================================================

/**
 * Check if Cursor has made recent commits (within last 60 seconds).
 * Cursor agent creates commits when making changes, similar to Aider.
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

function encodeCursorProjectPath(workspacePath: string): string {
  return workspacePath.replace(/^[\\/]+/, "").replace(/[/.]/g, "-");
}

function getCursorWorkerLogPath(workspacePath: string): string {
  return join(
    homedir(),
    ".cursor",
    "projects",
    encodeCursorProjectPath(workspacePath),
    "worker.log",
  );
}

async function getWorkerLogMtime(workspacePath: string): Promise<Date | null> {
  try {
    const workerLog = getCursorWorkerLogPath(workspacePath);
    await access(workerLog, constants.R_OK);
    const stats = await stat(workerLog);
    return stats.mtime;
  } catch {
    return null;
  }
}

function classifyRecentActivity(
  mtime: Date,
  threshold: number,
): ActivityDetection {
  const ageMs = Date.now() - mtime.getTime();
  const activeWindowMs = Math.min(30_000, threshold);
  if (ageMs < activeWindowMs) {
    return { state: "active", timestamp: mtime };
  }
  if (ageMs < threshold) {
    return { state: "ready", timestamp: mtime };
  }
  return { state: "idle", timestamp: mtime };
}

function buildCursorInvocation(binary: string): string[] {
  const binaryName = basename(binary);
  if (binaryName === "cursor") {
    return [shellEscape(binary), "agent"];
  }
  return [shellEscape(binary)];
}

function buildInitialPrompt(config: AgentLaunchConfig): string | undefined {
  if (config.systemPromptFile) {
    if (config.prompt) {
      return `"$(cat ${shellEscape(config.systemPromptFile)}; printf '\\n\\n'; printf %s ${shellEscape(config.prompt)})"`;
    }
    return `"$(cat ${shellEscape(config.systemPromptFile)})"`;
  }

  if (config.systemPrompt && config.prompt) {
    return shellEscape(`${config.systemPrompt}\n\n${config.prompt}`);
  }

  if (config.systemPrompt) {
    return shellEscape(config.systemPrompt);
  }

  if (config.prompt) {
    return shellEscape(config.prompt);
  }

  return undefined;
}

// =============================================================================
// Binary Resolution
// =============================================================================

/**
 * Resolve the Cursor CLI binary path.
 * Prefer the dedicated `cursor-agent` binary, but fall back to the
 * `cursor agent` wrapper when that's all the user has installed.
 */
export async function resolveCursorBinary(): Promise<string> {
  // 1. Try PATH resolution first
  for (const candidate of ["cursor-agent", "cursor"]) {
    try {
      const { stdout } = await execFileAsync("which", [candidate], {
        timeout: 10_000,
      });
      const resolved = stdout.trim();
      if (resolved) return resolved;
    } catch {
      // Not found via which
    }
  }

  // 2. Check common install locations
  const home = homedir();
  const candidates = [
    "/usr/local/bin/cursor-agent",
    "/opt/homebrew/bin/cursor-agent",
    join(home, ".local", "bin", "cursor-agent"),
    "/usr/local/bin/cursor",
    "/opt/homebrew/bin/cursor",
    join(home, ".local", "bin", "cursor"),
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
  ];

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Not found at this location
    }
  }

  // 3. Fallback: let the shell resolve it
  return "cursor-agent";
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
  let resolvedBinary: string | null = null;
  let resolvingBinary: Promise<string> | null = null;

  return {
    name: "cursor",
    processName: "cursor-agent",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const binary = resolvedBinary ?? "cursor-agent";
      const parts: string[] = [
        ...buildCursorInvocation(binary),
        "--workspace",
        shellEscape(config.projectConfig.path),
      ];

      const permissionMode = normalizePermissionMode(config.permissions);
      if (permissionMode === "suggest") {
        parts.push("--mode", "plan");
      }
      if (
        permissionMode === "permissionless" ||
        permissionMode === "auto-edit"
      ) {
        parts.push("--force");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      const initialPrompt = buildInitialPrompt(config);
      if (initialPrompt) {
        parts.push(initialPrompt);
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};

      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      const apiKey = process.env["CURSOR_API_KEY"];
      if (apiKey) {
        env["CURSOR_API_KEY"] = apiKey;
      }

      const authToken = process.env["CURSOR_AUTH_TOKEN"];
      if (authToken) {
        env["CURSOR_AUTH_TOKEN"] = authToken;
      }

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      if (/^[>$#]\s*$/.test(lastLine)) return "idle";

      const tail = lines.slice(-5).join("\n");
      if (/permission.*required/i.test(tail)) return "waiting_input";
      if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";
      if (/allow.*deny/i.test(tail)) return "waiting_input";
      if (/approve|reject/i.test(tail)) return "waiting_input";

      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      const exitedAt = new Date();
      if (!session.runtimeHandle) {
        return { state: "exited", timestamp: exitedAt };
      }
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      if (!session.workspacePath) return null;

      const hasCommits = await hasRecentCommits(session.workspacePath);
      if (hasCommits) return { state: "active" };

      const workerLogMtime = await getWorkerLogMtime(session.workspacePath);
      if (!workerLogMtime) return null;

      return classifyRecentActivity(workerLogMtime, threshold);
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

          const { stdout: psOut } = await execFileAsync(
            "ps",
            ["-eo", "pid,tty,args"],
            { timeout: 30_000 },
          );
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)(?:cursor-agent|cursor)(?:\s|$)/;
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
            if (
              err instanceof Error &&
              "code" in err &&
              err.code === "EPERM"
            ) {
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

    async postLaunchSetup(_session: Session): Promise<void> {
      if (!resolvedBinary) {
        if (!resolvingBinary) {
          resolvingBinary = resolveCursorBinary();
        }
        try {
          resolvedBinary = await resolvingBinary;
        } finally {
          resolvingBinary = null;
        }
      }
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
    execFileSync("cursor-agent", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    try {
      execFileSync("cursor", ["agent", "--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
