import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  readLastJsonlEntry,
  normalizeAgentPermissionMode,
  buildAgentPath,
  setupPathWrapperWorkspace,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  PREFERRED_GH_PATH,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityState,
  type ActivityDetection,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@composio/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
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

/** Copilot session state directory: ~/.copilot/session-state/<sessionId>/ */
const COPILOT_SESSIONS_DIR = join(homedir(), ".copilot", "session-state");

/**
 * Parse the handful of fields we need from Copilot's workspace.yaml.
 * We avoid pulling in a full YAML parser — workspace.yaml is flat
 * `key: value` pairs written by Copilot, so a line scan is sufficient.
 */
interface CopilotWorkspaceMeta {
  id: string | null;
  cwd: string | null;
  gitRoot: string | null;
  summary: string | null;
  branch: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function parseWorkspaceYaml(content: string): CopilotWorkspaceMeta {
  const meta: CopilotWorkspaceMeta = {
    id: null,
    cwd: null,
    gitRoot: null,
    summary: null,
    branch: null,
    createdAt: null,
    updatedAt: null,
  };
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    // Only top-level keys — workspace.yaml has no nesting in the fields we need.
    const match = /^([A-Za-z_][A-Za-z0-9_]*): ?(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case "id":
        meta.id = value;
        break;
      case "cwd":
        meta.cwd = value;
        break;
      case "git_root":
        meta.gitRoot = value;
        break;
      case "summary":
        meta.summary = value;
        break;
      case "branch":
        meta.branch = value;
        break;
      case "created_at":
        meta.createdAt = value;
        break;
      case "updated_at":
        meta.updatedAt = value;
        break;
    }
  }
  return meta;
}

/** Metadata about a matched Copilot session on disk. */
interface MatchedSession {
  sessionId: string;
  dir: string;
  eventsPath: string;
  workspace: CopilotWorkspaceMeta;
  mtimeMs: number;
}

/**
 * Scan ~/.copilot/session-state/ and return the most recently updated
 * session whose workspace.yaml cwd matches the given workspace path.
 */
async function findCopilotSession(workspacePath: string): Promise<MatchedSession | null> {
  let entries: string[];
  try {
    entries = await readdir(COPILOT_SESSIONS_DIR);
  } catch {
    return null;
  }

  let best: MatchedSession | null = null;

  for (const sessionId of entries) {
    const dir = join(COPILOT_SESSIONS_DIR, sessionId);
    const workspaceYamlPath = join(dir, "workspace.yaml");
    const eventsPath = join(dir, "events.jsonl");

    let content: string;
    try {
      content = await readFile(workspaceYamlPath, "utf-8");
    } catch {
      continue;
    }
    const workspace = parseWorkspaceYaml(content);
    // Match on either cwd or git_root — Copilot may record either depending
    // on how the session was launched (from the workspace vs from a subdir).
    if (workspace.cwd !== workspacePath && workspace.gitRoot !== workspacePath) {
      continue;
    }

    // Use events.jsonl mtime if present (latest session activity), falling
    // back to workspace.yaml mtime (session creation/rename).
    let mtimeMs: number;
    try {
      const s = await stat(eventsPath);
      mtimeMs = s.mtimeMs;
    } catch {
      try {
        const s = await stat(workspaceYamlPath);
        mtimeMs = s.mtimeMs;
      } catch {
        continue;
      }
    }

    if (!best || mtimeMs > best.mtimeMs) {
      best = { sessionId, dir, eventsPath, workspace, mtimeMs };
    }
  }

  return best;
}

/** TTL for session cache — matches agent-codex to keep lifecycle polls cheap. */
const SESSION_CACHE_TTL_MS = 30_000;
const sessionCache = new Map<string, { value: MatchedSession | null; expiry: number }>();

async function findCopilotSessionCached(workspacePath: string): Promise<MatchedSession | null> {
  const cached = sessionCache.get(workspacePath);
  if (cached && Date.now() < cached.expiry) return cached.value;
  const value = await findCopilotSession(workspacePath);
  sessionCache.set(workspacePath, { value, expiry: Date.now() + SESSION_CACHE_TTL_MS });
  return value;
}

/** @internal Exposed for tests — clears the module-level cache. */
export function _resetSessionCache(): void {
  sessionCache.clear();
}

// =============================================================================
// Binary Resolution
// =============================================================================

/**
 * Resolve the Copilot CLI binary path. `copilot` is typically installed via
 * npm global or Homebrew. Falls back to the bare name so the shell can
 * resolve it at runtime.
 */
export async function resolveCopilotBinary(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("which", ["copilot"], { timeout: 10_000 });
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {
    // Not found via which
  }

  const home = homedir();
  const candidates = [
    "/usr/local/bin/copilot",
    "/opt/homebrew/bin/copilot",
    join(home, ".npm-global", "bin", "copilot"),
    join(home, ".npm", "bin", "copilot"),
  ];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Not found at this location
    }
  }
  return "copilot";
}

// =============================================================================
// Command Construction Helpers
// =============================================================================

/**
 * Append permission flags to the command parts array.
 *
 * Copilot uses `--allow-all-tools` (equivalent to our "auto-edit" / default
 * autonomous mode) and `--yolo` (skip every confirmation — our
 * "permissionless" mode). "suggest" mode omits the flag so Copilot prompts
 * normally.
 */
function appendPermissionFlags(parts: string[], permissions: string | undefined): void {
  const mode = normalizeAgentPermissionMode(permissions);
  if (mode === "permissionless") {
    parts.push("--yolo");
  } else if (mode === "auto-edit" || mode === "default" || mode === undefined) {
    // AO runs agents autonomously by default, so always allow tools unless
    // the user explicitly asks for suggest mode.
    parts.push("--allow-all-tools");
  }
  // mode === "suggest": no flag, Copilot will prompt for each tool.
}

/** Append the `--model` flag if the user configured one. */
function appendModelFlag(parts: string[], model: string | undefined): void {
  if (model) parts.push("--model", shellEscape(model));
}

/** Common flags that should always be present for AO-managed sessions. */
function appendCommonFlags(parts: string[]): void {
  // Disable interactive follow-up questions — AO can't answer them.
  parts.push("--no-ask-user");
  // Autopilot mode keeps Copilot working until the task is done.
  parts.push("--autopilot");
  // AO's own update logic manages binary versions.
  parts.push("--no-auto-update");
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createCopilotAgent(): Agent {
  let resolvedBinary: string | null = null;
  let resolvingBinary: Promise<string> | null = null;

  return {
    name: "copilot",
    processName: "copilot",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const binary = resolvedBinary ?? "copilot";
      const parts: string[] = [shellEscape(binary)];
      appendCommonFlags(parts);
      appendPermissionFlags(parts, config.permissions);
      appendModelFlag(parts, config.model);

      // Copilot doesn't support a dedicated system-prompt flag; it reads
      // AGENTS.md / .copilot/instructions.md from the workspace. We pass
      // the system prompt content through AGENTS.md (written separately
      // by setupWorkspaceHooks) rather than as a CLI argument.

      if (config.prompt) {
        // -i starts interactive mode and immediately executes the prompt,
        // keeping the session alive for AO to inject follow-up messages.
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
      // Prepend ~/.ao/bin so gh/git wrappers can intercept commands Copilot
      // runs via its bash tool.
      env["PATH"] = buildAgentPath(process.env["PATH"]);
      env["GH_PATH"] = PREFERRED_GH_PATH;
      // Equivalent to `--allow-all-tools` — belt-and-suspenders in case
      // the CLI flag is stripped somewhere.
      env["COPILOT_ALLOW_ALL"] = "1";
      // Copilot's Ink TUI uses the alternate screen buffer by default,
      // which blocks tmux send-keys from reaching the input handler.
      // TERM=dumb disables alt-screen and rich terminal features so that
      // runtime.sendMessage() (send-keys + Enter) works reliably.
      env["TERM"] = "dumb";
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trimEnd().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";
      const tail = lines.slice(-8).join("\n");

      // Error / rate-limit / quota exhaustion — surface as blocked so the
      // lifecycle can react. Keep this list close to Copilot's actual
      // error surfaces; don't overmatch common words.
      if (
        /rate.?limit(ed)?/i.test(tail) ||
        /quota exceeded/i.test(tail) ||
        /premium request.*(exceeded|exhausted)/i.test(tail) ||
        /\b(429|403 Forbidden)\b/.test(tail) ||
        /authentication failed/i.test(tail)
      ) {
        return "blocked";
      }

      // Permission prompts — Copilot displays "Allow this command?" with
      // y/n/a choices when --allow-all-tools is NOT set.
      if (
        /allow this (command|tool)\??/i.test(tail) ||
        /\[y\/n(\/a)?\]/i.test(tail) ||
        /press y to allow/i.test(tail) ||
        /confirm:/i.test(lastLine)
      ) {
        return "waiting_input";
      }

      // Idle prompt — empty Copilot input line (Ink-based TUI renders `>`
      // followed by whitespace / cursor).
      if (/^[>❯$#]\s*$/.test(lastLine) || lastLine === "" || /waiting for input/i.test(lastLine)) {
        return "idle";
      }

      // Everything else (spinners, streaming responses, tool execution
      // output) maps to active.
      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;
      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);

      // 1. Process check — always first.
      const now = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: now };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) {
        // Grace period: Copilot CLI takes a few seconds to boot inside the
        // tmux pane. During the spawning phase, if the process isn't
        // detectable yet, return null ("no data") so the lifecycle manager's
        // default handler keeps the session in "working" rather than marking
        // it "killed" prematurely.
        const SPAWN_GRACE_MS = 30_000;
        if (
          session.status === "spawning" &&
          Date.now() - session.createdAt.getTime() < SPAWN_GRACE_MS
        ) {
          return null;
        }
        return { state: "exited", timestamp: now };
      }

      if (!session.workspacePath) return null;

      // 2. Try Copilot's native events.jsonl — it records rich state we can
      //    map without relying on terminal scraping.
      const matched = await findCopilotSessionCached(session.workspacePath);
      if (matched) {
        const entry = await readLastJsonlEntry(matched.eventsPath);
        if (entry) {
          const ageMs = Date.now() - entry.modifiedAt.getTime();
          const timestamp = entry.modifiedAt;
          switch (entry.lastType) {
            case "session.shutdown":
              return { state: "exited", timestamp };
            case "session.warning":
              // Warnings are informational; only promote to blocked if fresh
              // AND the process is still running (caller already confirmed).
              if (ageMs <= activeWindowMs) return { state: "blocked", timestamp };
              return { state: ageMs > threshold ? "idle" : "ready", timestamp };
            case "user.message":
            case "assistant.message":
            case "assistant.turn_start":
            case "tool.execution_start":
            case "function":
              if (ageMs <= activeWindowMs) return { state: "active", timestamp };
              return { state: ageMs > threshold ? "idle" : "ready", timestamp };
            case "assistant.turn_end":
            case "tool.execution_complete":
            case "session.mode_changed":
            case "session.plan_changed":
              return { state: ageMs > threshold ? "idle" : "ready", timestamp };
            case "session.start":
            case "session.resume":
              if (ageMs <= activeWindowMs) return { state: "active", timestamp };
              return { state: ageMs > threshold ? "idle" : "ready", timestamp };
            default:
              // Unknown type — treat as generic activity with age decay.
              if (ageMs <= activeWindowMs) return { state: "active", timestamp };
              return { state: ageMs > threshold ? "idle" : "ready", timestamp };
          }
        }
      }

      // 3. AO activity JSONL — picks up waiting_input/blocked that the
      //    native JSONL missed (e.g. permission prompts in interactive mode).
      const activityResult = await readLastActivityEntry(session.workspacePath);
      const activityState = checkActivityLogState(activityResult);
      if (activityState) return activityState;

      // 4. JSONL fallback with age decay — safety net when native signal
      //    is absent (binary missing, new session not yet written, etc).
      const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
      if (fallback) return fallback;

      // 5. Last resort: use events.jsonl mtime for age-based classification.
      if (matched) {
        const ageMs = Date.now() - matched.mtimeMs;
        const timestamp = new Date(matched.mtimeMs);
        if (ageMs <= activeWindowMs) return { state: "active", timestamp };
        if (ageMs <= threshold) return { state: "ready", timestamp };
        return { state: "idle", timestamp };
      }

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
          // Copilot CLI ships as either `copilot` (binary) or `.copilot-wrapped`
          // (node wrapper) depending on install method — match both.
          const processRe = /(?:^|\/)\.?copilot(?:-wrapped)?(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) return true;
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
            if (err instanceof Error && "code" in err && err.code === "EPERM") return true;
            return false;
          }
        }

        return false;
      } catch {
        return false;
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const matched = await findCopilotSessionCached(session.workspacePath);
      if (!matched) return null;

      // Copilot writes the rolling summary into workspace.yaml as it runs,
      // so we don't need to stream events.jsonl for it.
      const summary = matched.workspace.summary?.trim() || null;

      return {
        summary,
        summaryIsFallback: summary === null,
        agentSessionId: matched.sessionId,
        // Copilot does not expose token counts in events.jsonl yet — omit
        // cost rather than fake it. Revisit when the CLI adds usage events.
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;
      const matched = await findCopilotSessionCached(session.workspacePath);
      if (!matched) return null;

      const binary = resolvedBinary ?? "copilot";
      const parts: string[] = [shellEscape(binary)];
      appendCommonFlags(parts);
      appendPermissionFlags(parts, project.agentConfig?.permissions);
      appendModelFlag(parts, project.agentConfig?.model);
      parts.push(`--resume=${shellEscape(matched.sessionId)}`);
      return parts.join(" ");
    },

    async setupWorkspaceHooks(
      workspacePath: string,
      _config: WorkspaceHooksConfig,
    ): Promise<void> {
      await setupPathWrapperWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!resolvedBinary) {
        if (!resolvingBinary) {
          resolvingBinary = resolveCopilotBinary();
        }
        try {
          resolvedBinary = await resolvingBinary;
        } finally {
          resolvingBinary = null;
        }
      }
      if (!session.workspacePath) return;
      await setupPathWrapperWorkspace(session.workspacePath);
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
