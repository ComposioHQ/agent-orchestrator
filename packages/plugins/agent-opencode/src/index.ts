import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  buildAgentPath,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  setupPathWrapperWorkspace,
  PREFERRED_GH_PATH,
  asValidOpenCodeSessionId,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type AgentRuntimeHints,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
  type OpenCodeAgentConfig,
} from "@composio/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface OpenCodeSessionListEntry {
  id: string;
  title?: string;
  updated?: string | number;
  directory?: string;
  createdAt?: number;
}

const OPENCODE_PROCESS_RE =
  /(?:^|\/)(?:opencode|\.opencode)(?:\s|$)|(?:^|\/)node(?:\s|$).*(?:^|\s)(?:\/\S*\/opencode|\/\S*\/\.opencode)(?:\s|$)/;

function parseUpdatedTimestamp(updated: string | number | undefined): Date | null {
  if (typeof updated === "number") {
    if (!Number.isFinite(updated)) return null;
    const date = new Date(updated);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof updated !== "string") return null;

  const trimmed = updated.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+$/.test(trimmed)) {
    const epochMs = Number(trimmed);
    if (!Number.isFinite(epochMs)) return null;
    const date = new Date(epochMs);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return null;
  return new Date(parsedMs);
}

function parseSessionList(raw: string): OpenCodeSessionListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is OpenCodeSessionListEntry => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return asValidOpenCodeSessionId(record["id"]) !== undefined;
  });
}

function extractSessionIdFromArgs(args: string): string | null {
  const match = args.match(/(?:^|\s)--session\s+(['"]?)(ses_[A-Za-z0-9_-]+)\1(?:\s|$)/);
  return match?.[2] ?? null;
}

async function findOpenCodeSessionIdFromRuntime(
  handle: RuntimeHandle | null,
): Promise<string | null> {
  if (!handle) return null;

  try {
    if (handle.runtimeName === "docker" && handle.id) {
      const containerName =
        typeof handle.data["containerName"] === "string" ? handle.data["containerName"] : handle.id;
      const { stdout } = await execFileAsync(
        "docker",
        ["exec", containerName, "ps", "-eo", "args"],
        { timeout: 30_000 },
      );
      for (const line of stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
        if (!OPENCODE_PROCESS_RE.test(line)) continue;
        const sessionId = extractSessionIdFromArgs(line);
        if (sessionId) return sessionId;
      }
      return null;
    }

    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync(
        "tmux",
        ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
        { timeout: 30_000 },
      );
      const ttys = ttyOut
        .trim()
        .split("\n")
        .map((entry) => entry.trim().replace(/^\/dev\//, ""))
        .filter(Boolean);
      if (ttys.length === 0) return null;

      const ttySet = new Set(ttys);
      const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
        timeout: 30_000,
      });
      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        const args = cols.slice(2).join(" ");
        if (!OPENCODE_PROCESS_RE.test(args)) continue;
        const sessionId = extractSessionIdFromArgs(args);
        if (sessionId) return sessionId;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Parse JSON stream lines from `opencode run --format json` output.
 * Each line is a JSON object. We look for objects containing a session_id field.
 * The step_start event typically contains the session_id.
 */
function scoreStorageCandidate(session: Session, candidate: OpenCodeSessionListEntry): number {
  let score = 0;
  if (candidate.title === `AO:${session.id}`) {
    score += 1_000_000;
  }
  if (session.workspacePath && candidate.directory === session.workspacePath) {
    score += 100_000;
  }
  if (candidate.createdAt) {
    const delta = Math.abs(candidate.createdAt - session.createdAt.getTime());
    score += Math.max(0, 60_000 - Math.min(delta, 60_000));
  }
  return score;
}

async function loadStorageSessions(): Promise<OpenCodeSessionListEntry[]> {
  const root = join(homedir(), ".local", "share", "opencode", "storage", "session");
  const sessions: OpenCodeSessionListEntry[] = [];

  let groups;
  try {
    groups = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const group of groups) {
    if (!group.isDirectory()) continue;

    let files;
    try {
      files = await readdir(join(root, group.name), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const fullPath = join(root, group.name, file.name);

      try {
        const parsed = JSON.parse(await readFile(fullPath, "utf-8")) as Record<string, unknown>;
        const id = asValidOpenCodeSessionId(parsed["id"]);
        if (!id) continue;
        const title = typeof parsed["title"] === "string" ? parsed["title"] : undefined;
        const directory =
          typeof parsed["directory"] === "string" ? parsed["directory"] : undefined;
        const time =
          parsed["time"] && typeof parsed["time"] === "object"
            ? (parsed["time"] as Record<string, unknown>)
            : undefined;
        const createdAt =
          typeof time?.["created"] === "number" && Number.isFinite(time["created"])
            ? time["created"]
            : undefined;
        const updated =
          typeof time?.["updated"] === "number" && Number.isFinite(time["updated"])
            ? time["updated"]
            : undefined;
        sessions.push({ id, title, directory, createdAt, updated });
      } catch {
        continue;
      }
    }
  }

  return sessions;
}

async function findOpenCodeSessionFromStorage(
  session: Session,
  preferredSessionId?: string,
): Promise<OpenCodeSessionListEntry | null> {
  const sessions = await loadStorageSessions();
  if (sessions.length === 0) return null;

  if (preferredSessionId) {
    const byId = sessions.find((candidate) => candidate.id === preferredSessionId);
    if (byId) return byId;
  }

  const candidates = sessions
    .filter((candidate) => {
      if (candidate.title === `AO:${session.id}`) return true;
      return Boolean(session.workspacePath && candidate.directory === session.workspacePath);
    })
    .sort((left, right) => {
      const leftScore = scoreStorageCandidate(session, left);
      const rightScore = scoreStorageCandidate(session, right);
      if (leftScore !== rightScore) return rightScore - leftScore;
      const leftUpdated = parseUpdatedTimestamp(left.updated)?.getTime() ?? Number.NEGATIVE_INFINITY;
      const rightUpdated =
        parseUpdatedTimestamp(right.updated)?.getTime() ?? Number.NEGATIVE_INFINITY;
      return rightUpdated - leftUpdated;
    });

  return candidates[0] ?? null;
}

// =============================================================================
// Session List Helpers
// =============================================================================

/**
 * Query OpenCode's session list and find the matching session for this AO session.
 * Tries metadata `opencodeSessionId` first, then falls back to title matching.
 */
async function findOpenCodeSession(
  session: Session,
): Promise<OpenCodeSessionListEntry | null> {
  const runtimeSessionId = await findOpenCodeSessionIdFromRuntime(session.runtimeHandle);
  const mappedSessionId = asValidOpenCodeSessionId(session.metadata?.opencodeSessionId);
  const preferredSessionId = mappedSessionId ?? runtimeSessionId ?? undefined;

  try {
    const { stdout } = await execFileAsync(
      "opencode",
      ["session", "list", "--format", "json"],
      { timeout: 30_000 },
    );

    const sessions = parseSessionList(stdout);

    // Prefer exact ID match from metadata
    if (preferredSessionId) {
      const match = sessions.find((s) => s.id === preferredSessionId);
      if (match) return match;
    }

    // Fallback: title match — pick the most recently updated session
    // to avoid binding to a stale session when titles collide.
    const titleMatches = sessions.filter((s) => s.title === `AO:${session.id}`);
    if (titleMatches.length === 0) {
      return (
        (await findOpenCodeSessionFromStorage(session, preferredSessionId)) ??
        (runtimeSessionId
          ? {
              id: runtimeSessionId,
              title: `AO:${session.id}`,
            }
          : null)
      );
    }
    if (titleMatches.length === 1) return titleMatches[0]!;
    return titleMatches.reduce((best, s) => {
      const bestTs = parseUpdatedTimestamp(best.updated)?.getTime() ?? 0;
      const sTs = parseUpdatedTimestamp(s.updated)?.getTime() ?? 0;
      return sTs > bestTs ? s : best;
    });
  } catch {
    return (
      (await findOpenCodeSessionFromStorage(session, preferredSessionId)) ??
      (runtimeSessionId
        ? {
            id: runtimeSessionId,
            title: `AO:${session.id}`,
          }
        : null)
    );
  }
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "opencode",
  slot: "agent" as const,
  description: "Agent plugin: OpenCode",
  version: "0.1.0",
  displayName: "OpenCode",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createOpenCodeAgent(): Agent {
  return {
    name: "opencode",
    processName: "opencode",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const options: string[] = [];
      const sharedOptions: string[] = [];

      const existingSessionId = asValidOpenCodeSessionId(
        (config.projectConfig.agentConfig as OpenCodeAgentConfig | undefined)?.opencodeSessionId,
      );

      if (existingSessionId) {
        options.push("--session", shellEscape(existingSessionId));
      }

      // Select specific OpenCode subagent if configured
      if (config.subagent) {
        sharedOptions.push("--agent", shellEscape(config.subagent));
      }

      let promptValue: string | undefined;
      if (config.prompt) {
        if (config.systemPromptFile) {
          promptValue = `"$(cat ${shellEscape(config.systemPromptFile)}; printf '\\n\\n'; printf %s ${shellEscape(config.prompt)})"`;
        } else if (config.systemPrompt) {
          promptValue = shellEscape(`${config.systemPrompt}\n\n${config.prompt}`);
        } else {
          promptValue = shellEscape(config.prompt);
        }
      } else if (config.systemPromptFile) {
        promptValue = `"$(cat ${shellEscape(config.systemPromptFile)})"`;
      } else if (config.systemPrompt) {
        promptValue = shellEscape(config.systemPrompt);
      }

      if (config.model) {
        sharedOptions.push("--model", shellEscape(config.model));
      }

      if (!existingSessionId) {
        if (promptValue) {
          options.push("--prompt", promptValue);
        }
        options.push(...sharedOptions);
        return ["opencode", ...options].join(" ");
      }

      if (promptValue) {
        options.push("--prompt", promptValue);
      }

      options.push(...sharedOptions);

      return ["opencode", ...options].join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // Prepend ~/.ao/bin to PATH so our gh/git wrappers intercept commands.
      env["PATH"] = buildAgentPath(process.env["PATH"]);
      env["GH_PATH"] = PREFERRED_GH_PATH;

      return env;
    },

    getRuntimeHints(): AgentRuntimeHints {
      return {
        docker: {
          homeMounts: [
            { path: ".opencode", kind: "dir" },
            { path: ".config/opencode", kind: "dir" },
            { path: ".local/share/opencode/auth.json", kind: "file" },
          ],
          envDefaults: { OPENCODE_CONFIG_DIR: ".config/opencode" },
          envFromHost: [
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GOOGLE_API_KEY",
            "GEMINI_API_KEY",
            "ZAI_API_KEY",
            "ZAI_CODING_PLAN_API_KEY",
            "KIMI_API_KEY",
            "OPENROUTER_API_KEY",
            "GROK_API_KEY",
            "GITHUB_TOKEN",
            "COPILOT_API_KEY",
          ],
        },
      };
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      // OpenCode's input prompt — agent is idle
      if (/^[>$#]\s*$/.test(lastLine)) return "idle";

      // Check the last few lines for permission/confirmation prompts
      const tail = lines.slice(-5).join("\n");
      if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
      if (/approval required/i.test(tail)) return "waiting_input";
      if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";
      if (/Allow .+\?/i.test(tail)) return "waiting_input";

      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;
      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);

      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      // 1. Check AO activity JSONL first (written by recordActivity from terminal output).
      //    This is the only source of waiting_input/blocked states for OpenCode.
      let activityResult: Awaited<ReturnType<typeof readLastActivityEntry>> = null;
      if (session.workspacePath) {
        activityResult = await readLastActivityEntry(session.workspacePath);
        const activityState = checkActivityLogState(activityResult);
        if (activityState) return activityState;
      }

      // 2. Fallback: query OpenCode's session list API for timestamp-based detection
      const targetSession = await findOpenCodeSession(session);
      if (targetSession) {
        const lastActivity = parseUpdatedTimestamp(targetSession.updated);

        if (lastActivity) {
          const ageMs = Math.max(0, Date.now() - lastActivity.getTime());
          if (ageMs <= activeWindowMs) {
            return { state: "active", timestamp: lastActivity };
          }
          if (ageMs <= threshold) {
            return { state: "ready", timestamp: lastActivity };
          }
          return { state: "idle", timestamp: lastActivity };
        }
      }

      // 3. Fallback: use JSONL entry with age-based decay when session list is unavailable.
      const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
      if (fallback) return fallback;

      return null;
    },

    async recordActivity(session: Session, terminalOutput: string): Promise<void> {
      if (!session.workspacePath) return;
      await recordTerminalActivity(session.workspacePath, terminalOutput, (output) =>
        this.detectActivity(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "docker" && handle.id) {
          const containerName =
            typeof handle.data["containerName"] === "string"
              ? handle.data["containerName"]
              : handle.id;
          const { stdout } = await execFileAsync(
            "docker",
            ["exec", containerName, "ps", "-eo", "args"],
            { timeout: 30_000 },
          );
          return stdout
            .split("\n")
            .map((line) => line.trim())
            .some((line) => OPENCODE_PROCESS_RE.test(line));
        }

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
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (OPENCODE_PROCESS_RE.test(args)) {
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
      const targetSession = await findOpenCodeSession(session);
      if (!targetSession) return null;

      return {
        summary: targetSession.title ?? null,
        summaryIsFallback: true,
        agentSessionId: targetSession.id,
        // OpenCode doesn't expose token/cost data in session list
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      // Try metadata first, then query OpenCode's session list
      const sessionId =
        asValidOpenCodeSessionId(session.metadata?.opencodeSessionId) ??
        (await findOpenCodeSession(session))?.id ??
        null;

      if (!sessionId) return null;

      const parts: string[] = ["opencode", "--session", shellEscape(sessionId)];

      const agentConfig = project.agentConfig as OpenCodeAgentConfig | undefined;
      if (agentConfig?.model) {
        parts.push("--model", shellEscape(agentConfig.model as string));
      }

      return parts.join(" ");
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupPathWrapperWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await setupPathWrapperWorkspace(session.workspacePath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createOpenCodeAgent();
}

export function detect(): boolean {
  try {
    execFileSync("opencode", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
