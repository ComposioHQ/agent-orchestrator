import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
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
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// =============================================================================
// Kimi Session Directory Helpers
// =============================================================================

/** Kimi stores sessions under ~/.kimi/ (override via KIMI_SHARE_DIR). */
function kimiShareDir(): string {
  const override = process.env["KIMI_SHARE_DIR"];
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".kimi");
}

/**
 * Find the Kimi session directory whose `state.json` references this workspace.
 * Scans immediate subdirectories of ~/.kimi/ looking for a `state.json` with a
 * matching `cwd`/`work_dir`/`workdir` field. Returns the most recently modified
 * match, or null when nothing matches.
 */
async function findKimiSessionDir(workspacePath: string): Promise<string | null> {
  const root = kimiShareDir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }

  let best: { path: string; mtime: number } | null = null;

  for (const entry of entries) {
    const dir = join(root, entry);
    const stateFile = join(dir, "state.json");
    try {
      const raw = await readFile(stateFile, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const state = parsed as Record<string, unknown>;
      const cwd =
        typeof state["cwd"] === "string"
          ? state["cwd"]
          : typeof state["work_dir"] === "string"
            ? state["work_dir"]
            : typeof state["workdir"] === "string"
              ? state["workdir"]
              : null;
      if (cwd !== workspacePath) continue;

      const s = await stat(stateFile);
      if (!best || s.mtimeMs > best.mtime) {
        best = { path: dir, mtime: s.mtimeMs };
      }
    } catch {
      // Missing/unreadable/non-JSON state.json — skip this entry.
    }
  }

  return best?.path ?? null;
}

interface KimiSessionState {
  sessionId: string | null;
  model: string | null;
  title: string | null;
}

/** Parse the subset of fields we care about from a Kimi `state.json`. */
async function readKimiSessionState(sessionDir: string): Promise<KimiSessionState | null> {
  try {
    const raw = await readFile(join(sessionDir, "state.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    return {
      sessionId:
        typeof state["session_id"] === "string"
          ? state["session_id"]
          : typeof state["id"] === "string"
            ? state["id"]
            : null,
      model: typeof state["model"] === "string" ? state["model"] : null,
      title: typeof state["title"] === "string" ? state["title"] : null,
    };
  } catch {
    return null;
  }
}

/** Get the mtime of the freshest signal inside a Kimi session directory. */
async function getKimiSessionMtime(sessionDir: string): Promise<Date | null> {
  const candidates = ["context.jsonl", "wire.jsonl", "state.json"];
  let newest: Date | null = null;
  for (const name of candidates) {
    try {
      const s = await stat(join(sessionDir, name));
      if (!newest || s.mtimeMs > newest.getTime()) newest = s.mtime;
    } catch {
      // Missing file — skip.
    }
  }
  return newest;
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "kimicode",
  slot: "agent" as const,
  description: "Agent plugin: Kimi Code CLI (MoonshotAI)",
  version: "0.1.0",
  displayName: "Kimi Code",
};

// =============================================================================
// Agent Implementation
// =============================================================================

/**
 * Append approval flags — kimi uses `--yolo` (aka `-y`, `--yes`, `--auto-approve`).
 * Suggest/ask modes have no dedicated flag; kimi prompts inline by default.
 */
function appendApprovalFlags(parts: string[], permissions: string | undefined): void {
  const mode = normalizeAgentPermissionMode(permissions);
  if (mode === "permissionless" || mode === "auto-edit") {
    parts.push("--yolo");
  }
}

function createKimicodeAgent(): Agent {
  return {
    name: "kimicode",
    processName: "kimi",
    // `kimi -p <prompt>` implicitly enables `--print`/--yolo and exits after the
    // turn, which is incompatible with an interactive supervised session.
    // Deliver the initial prompt post-launch via runtime.sendMessage() instead.
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["kimi"];

      appendApprovalFlags(parts, config.permissions);

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      // Kimi does not have a documented system-prompt flag for ad-hoc injection;
      // agent-file is the closest, but requires a dedicated file on disk. Prefer
      // passing systemPromptFile directly as --agent-file when the caller asked
      // for a file-backed system prompt.
      if (config.systemPromptFile) {
        parts.push("--agent-file", shellEscape(config.systemPromptFile));
      }

      // NOTE: prompt is NOT included here — see promptDelivery comment above.

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // Prepend ~/.ao/bin so gh/git wrappers intercept PR/commit commands.
      env["PATH"] = buildAgentPath(process.env["PATH"]);
      env["GH_PATH"] = PREFERRED_GH_PATH;

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      // Generic shell/REPL prompt — agent is idle waiting for user input.
      if (/^[>$#]\s*$/.test(lastLine)) return "idle";
      // Kimi's interactive prompt variants.
      if (/^kimi[>:]?\s*$/i.test(lastLine)) return "idle";

      const tail = lines.slice(-6).join("\n");

      // Approval / confirmation prompts.
      if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";
      if (/\[y\/n\]/i.test(tail)) return "waiting_input";
      if (/approve\??/i.test(tail)) return "waiting_input";
      if (/approval required/i.test(tail)) return "waiting_input";
      if (/do you want to (proceed|continue)\?/i.test(tail)) return "waiting_input";
      if (/allow .+\?/i.test(tail)) return "waiting_input";

      // Hard errors surfaced to the terminal.
      if (/^error:/im.test(tail)) return "blocked";
      if (/failed to (connect|authenticate|load)/i.test(tail)) return "blocked";

      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;
      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);

      // 1. Process check — always first.
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      if (!session.workspacePath) return null;

      // 2. Actionable states (waiting_input / blocked) sourced from the AO
      //    activity JSONL written by recordActivity. Kimi's native JSONL format
      //    is not publicly documented, so terminal-derived state is our only
      //    reliable source for approval/error detection.
      const activityResult = await readLastActivityEntry(session.workspacePath);
      const activityState = checkActivityLogState(activityResult);
      if (activityState) return activityState;

      // 3. Native signal — mtime of context.jsonl / wire.jsonl / state.json
      //    inside the matching ~/.kimi/<session>/ directory.
      const sessionDir = await findKimiSessionDir(session.workspacePath);
      if (sessionDir) {
        const mtime = await getKimiSessionMtime(sessionDir);
        if (mtime) {
          const ageMs = Math.max(0, Date.now() - mtime.getTime());
          if (ageMs <= activeWindowMs) return { state: "active", timestamp: mtime };
          if (ageMs <= threshold) return { state: "ready", timestamp: mtime };
          return { state: "idle", timestamp: mtime };
        }
      }

      // 4. JSONL entry fallback (MANDATORY) — uses the last AO activity entry
      //    with age-based decay when the native signal is unavailable.
      const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
      if (fallback) return fallback;

      // 5. No data available.
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
          // Match both `kimi` and `.kimi` (some installers use a dot-prefixed
          // shim), as well as `uv run kimi` / `python -m kimi` invocations.
          const processRe = /(?:^|\/)\.?kimi(?:\s|$)|(?:\s|^)kimi(?:\s|$)/;
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
      if (!session.workspacePath) return null;

      const sessionDir = await findKimiSessionDir(session.workspacePath);
      if (!sessionDir) return null;

      const state = await readKimiSessionState(sessionDir);
      if (!state) return null;

      const summary = state.title ?? (state.model ? `Kimi session (${state.model})` : null);

      return {
        summary,
        summaryIsFallback: true,
        agentSessionId: state.sessionId,
        // Kimi does not expose token/cost data in state.json.
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      const sessionDir = await findKimiSessionDir(session.workspacePath);
      if (!sessionDir) return null;

      const state = await readKimiSessionState(sessionDir);
      if (!state?.sessionId) {
        // Fall back to `--continue` which resumes the latest session for the
        // current working directory. The runtime spawns kimi with cwd set to
        // the workspace, so this is safe.
        const parts: string[] = ["kimi", "--continue"];
        appendApprovalFlags(parts, project.agentConfig?.permissions);
        if (project.agentConfig?.model) {
          parts.push("--model", shellEscape(project.agentConfig.model as string));
        }
        return parts.join(" ");
      }

      const parts: string[] = ["kimi", "--resume", shellEscape(state.sessionId)];
      appendApprovalFlags(parts, project.agentConfig?.permissions);
      const effectiveModel = (project.agentConfig?.model ?? state.model) as string | undefined;
      if (effectiveModel) {
        parts.push("--model", shellEscape(effectiveModel));
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
  return createKimicodeAgent();
}

export function detect(): boolean {
  try {
    execFileSync("kimi", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
