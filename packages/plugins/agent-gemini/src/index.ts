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
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function normalizePermissionMode(
  mode: string | undefined,
): "permissionless" | "default" | "auto-edit" | "suggest" | undefined {
  if (!mode) return undefined;
  if (mode === "skip") return "permissionless";
  if (mode === "permissionless" || mode === "default" || mode === "auto-edit" || mode === "suggest") {
    return mode;
  }
  return undefined;
}

// =============================================================================
// Metadata Updater Hook Script
// =============================================================================

/**
 * Hook script registered as Gemini CLI's AfterTool event.
 * Intercepts run_shell_command calls and auto-updates AO session metadata when:
 * - gh pr create : extracts and stores PR URL + sets status=pr_open
 * - git checkout -b / git switch -c : captures branch name
 * - gh pr merge : sets status=merged
 *
 * Exported for integration testing.
 */
/* eslint-disable no-useless-escape -- \$ escapes are intentional: bash scripts in JS template literals */
export const METADATA_UPDATER_SCRIPT = `#!/usr/bin/env bash
# Metadata Updater Hook for Agent Orchestrator (Gemini CLI)
# AfterTool hook — Gemini calls this after every run_shell_command execution.
# Input : JSON on stdin  (session_id, tool_name, tool_input, tool_response, …)
# Output: JSON on stdout (empty {} by default, systemMessage on updates)

set -euo pipefail

AO_DATA_DIR="\${AO_DATA_DIR:-\$HOME/.ao-sessions}"

input=\$(cat)

# ---- parse JSON (jq fast path, regex fallback) ----
if command -v jq &>/dev/null; then
  tool_name=\$(echo "\$input" | jq -r '.tool_name // empty')
  command=\$(echo "\$input"   | jq -r '.tool_input.command // empty')
  output=\$(echo "\$input"    | jq -r '.tool_response.llmContent // .tool_response // empty')
else
  tool_name=\$(echo "\$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  command=\$(echo "\$input"   | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  output=\$(echo "\$input"    | grep -o '"llmContent"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
fi

# Only care about shell commands
[[ "\$tool_name" == "run_shell_command" ]] || { echo '{}'; exit 0; }

# Need AO_SESSION to locate the metadata file
if [[ -z "\${AO_SESSION:-}" ]]; then
  echo '{"systemMessage":"AO_SESSION not set — skipping metadata update"}'
  exit 0
fi

# Path traversal guard on session name
case "\$AO_SESSION" in */* | *..*) echo '{}'; exit 0 ;; esac

# Restrict AO_DATA_DIR to known safe prefixes
case "\$AO_DATA_DIR" in
  "\$HOME"/.ao/* | "\$HOME"/.agent-orchestrator/* | /tmp/*) ;;
  *) echo '{}'; exit 0 ;;
esac

metadata_file="\$AO_DATA_DIR/\$AO_SESSION"

# Confirm metadata file is still inside ao_dir after symlink resolution
real_ao_dir=\$(cd "\$AO_DATA_DIR" 2>/dev/null && pwd -P) || { echo '{}'; exit 0; }
real_dir=\$(cd "\$(dirname "\$metadata_file")" 2>/dev/null && pwd -P) || { echo '{}'; exit 0; }
[[ "\$real_dir" == "\$real_ao_dir"* ]] || { echo '{}'; exit 0; }
[[ -f "\$metadata_file" ]]             || { echo '{}'; exit 0; }

# ---- update a key=value line in the metadata file ----
update_metadata_key() {
  local key="\$1" value="\$2"
  local tmp="\${metadata_file}.tmp.\$\$"
  local clean=\$(printf '%s' "\$value" | tr -d '\\n')
  local esc=\$(printf '%s' "\$clean" | sed 's/[&|\\\\]/\\\\&/g')
  if grep -q "^\${key}=" "\$metadata_file" 2>/dev/null; then
    sed "s|^\${key}=.*|\${key}=\${esc}|" "\$metadata_file" > "\$tmp"
  else
    cp "\$metadata_file" "\$tmp"
    printf '%s=%s\\n' "\$key" "\$clean" >> "\$tmp"
  fi
  mv "\$tmp" "\$metadata_file"
}

# ---- strip leading "cd ... &&" prefixes so we match the real command ----
cd_pat='^[[:space:]]*cd[[:space:]]+.*[[:space:]]+(&&|;)[[:space:]]+(.*)'
clean_cmd="\$command"
while [[ "\$clean_cmd" =~ ^[[:space:]]*cd[[:space:]] ]]; do
  [[ "\$clean_cmd" =~ \$cd_pat ]] && clean_cmd="\${BASH_REMATCH[2]}" || break
done

# ---- event: gh pr create ----
if [[ "\$clean_cmd" =~ ^gh[[:space:]]+pr[[:space:]]+create ]]; then
  pr_url=\$(echo "\$output" | grep -Eo 'https://github[.]com/[^/]+/[^/]+/pull/[0-9]+' | head -1)
  if [[ -n "\$pr_url" ]]; then
    update_metadata_key "pr"     "\$pr_url"
    update_metadata_key "status" "pr_open"
    echo "{\"systemMessage\":\"Updated metadata: PR created at \$pr_url\"}"
    exit 0
  fi
fi

# ---- event: git checkout -b / git switch -c (new branch) ----
if [[ "\$clean_cmd" =~ ^git[[:space:]]+checkout[[:space:]]+-b[[:space:]]+([^[:space:]]+) ]] || \\
   [[ "\$clean_cmd" =~ ^git[[:space:]]+switch[[:space:]]+-c[[:space:]]+([^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"
  if [[ -n "\$branch" ]]; then
    update_metadata_key "branch" "\$branch"
    echo "{\"systemMessage\":\"Updated metadata: branch = \$branch\"}"
    exit 0
  fi
fi

# ---- event: git checkout/switch <feature-branch> (no -b/-c flag) ----
if [[ "\$clean_cmd" =~ ^git[[:space:]]+checkout[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]] || \\
   [[ "\$clean_cmd" =~ ^git[[:space:]]+switch[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"
  if [[ -n "\$branch" && "\$branch" != "HEAD" ]]; then
    update_metadata_key "branch" "\$branch"
    echo "{\"systemMessage\":\"Updated metadata: branch = \$branch\"}"
    exit 0
  fi
fi

# ---- event: gh pr merge ----
if [[ "\$clean_cmd" =~ ^gh[[:space:]]+pr[[:space:]]+merge ]]; then
  update_metadata_key "status" "merged"
  echo '{"systemMessage":"Updated metadata: status = merged"}'
  exit 0
fi

echo '{}'
exit 0
`;
/* eslint-enable no-useless-escape */

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "gemini",
  slot: "agent" as const,
  description: "Agent plugin: Google Gemini CLI",
  version: "0.1.0",
  displayName: "Google Gemini CLI",
};

// =============================================================================
// Session File Helpers
// =============================================================================

/**
 * Compute the project hash used by Gemini CLI to namespace session data.
 * Gemini uses sha256(projectRoot).digest('hex') — the full 64-char hex string.
 * Verified against packages/core/src/utils/paths.ts#getProjectHash in the
 * google-gemini/gemini-cli repository.
 */
export function getGeminiProjectHash(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex");
}

/**
 * Returns the directory where Gemini CLI stores per-session JSON files.
 * Path: ~/.gemini/tmp/<sha256(projectRoot)>/chats/
 */
export function getGeminiChatsDir(projectRoot: string): string {
  const hash = getGeminiProjectHash(projectRoot);
  return join(homedir(), ".gemini", "tmp", hash, "chats");
}

/**
 * Minimum slice of a Gemini ConversationRecord that we need.
 * (Full type lives in @google/gemini-cli-core — we avoid the dep.)
 */
interface GeminiSessionFile {
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
  summary?: string;
  messages?: Array<{
    type?: string;
    content?: unknown;
    tokens?: {
      input?: number;
      output?: number;
      cached?: number;
      total?: number;
    } | null;
  }>;
}

/** Find the most recently modified session-*.json file in the chats dir. */
async function findLatestSessionFile(chatsDir: string): Promise<{ path: string; mtime: Date } | null> {
  let entries: string[];
  try {
    entries = await readdir(chatsDir);
  } catch {
    return null;
  }

  const jsonFiles = entries.filter((f) => f.startsWith("session-") && f.endsWith(".json"));
  if (jsonFiles.length === 0) return null;

  const withStats = await Promise.all(
    jsonFiles.map(async (f) => {
      const fullPath = join(chatsDir, f);
      try {
        const s = await stat(fullPath);
        return { path: fullPath, mtime: s.mtime };
      } catch {
        return { path: fullPath, mtime: new Date(0) };
      }
    }),
  );
  withStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return withStats[0] ?? null;
}

/** Parse a Gemini session JSON file. Returns null on any error. */
async function parseSessionFile(filePath: string): Promise<GeminiSessionFile | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as GeminiSessionFile;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract the first user message text as a fallback summary. */
function extractFirstUserMessage(session: GeminiSessionFile): string | null {
  if (!Array.isArray(session.messages)) return null;
  for (const msg of session.messages) {
    if (msg.type !== "user") continue;
    const content = msg.content;
    let text: string | null = null;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string"
        ) {
          text = (part as { text: string }).text;
          break;
        }
      }
    } else if (typeof content === "object" && content !== null && "text" in content) {
      const t = (content as { text: unknown }).text;
      if (typeof t === "string") text = t;
    }
    if (text && text.trim().length > 0) {
      const trimmed = text.trim();
      return trimmed.length > 120 ? trimmed.slice(0, 120) + "..." : trimmed;
    }
  }
  return null;
}

/** Sum token usage from all `gemini`-role messages. */
function extractCost(session: GeminiSessionFile): CostEstimate | undefined {
  if (!Array.isArray(session.messages)) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const msg of session.messages) {
    if (msg.type === "gemini" && msg.tokens) {
      inputTokens += msg.tokens.input ?? 0;
      inputTokens += msg.tokens.cached ?? 0;
      outputTokens += msg.tokens.output ?? 0;
    }
  }
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  // Gemini 2.5 Pro pricing (≈ $1.25/1M input tokens, $10/1M output tokens).
  // These are estimates — actual price depends on model and context length.
  const estimatedCostUsd = (inputTokens / 1_000_000) * 1.25 + (outputTokens / 1_000_000) * 10.0;
  return { inputTokens, outputTokens, estimatedCostUsd };
}

// =============================================================================
// Session File Cache
// =============================================================================

/** TTL for the session-file-path cache (ms). Prevents redundant readdir scans
 *  when getActivityState and getSessionInfo fire in the same 30-second poll. */
const SESSION_CACHE_TTL_MS = 30_000;

const sessionFileCache = new Map<string, { result: { path: string; mtime: Date } | null; expiry: number }>();

/** Reset the session file cache. Exported for testing only. */
export function resetSessionFileCache(): void {
  sessionFileCache.clear();
}

async function findLatestSessionFileCached(
  chatsDir: string,
): Promise<{ path: string; mtime: Date } | null> {
  const cached = sessionFileCache.get(chatsDir);
  if (cached && Date.now() < cached.expiry) return cached.result;
  const result = await findLatestSessionFile(chatsDir);
  sessionFileCache.set(chatsDir, { result, expiry: Date.now() + SESSION_CACHE_TTL_MS });
  return result;
}

// =============================================================================
// Process Detection (shared ps cache)
// =============================================================================

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
  const promise = execFileAsync("ps", ["-eo", "pid,tty,args"], { timeout: 5_000 }).then(
    ({ stdout }) => {
      if (psCache?.promise === promise) psCache = { output: stdout, timestamp: Date.now() };
      return stdout;
    },
  );
  psCache = { output: "", timestamp: now, promise };
  try {
    return await promise;
  } catch {
    if (psCache?.promise === promise) psCache = null;
    return "";
  }
}

/**
 * Find a running `gemini` process via the runtime handle.
 * - tmux: get pane TTY → cross-reference with `ps` output
 * - process: signal(pid, 0) liveness check
 */
async function findGeminiProcess(handle: RuntimeHandle): Promise<number | null> {
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
      // Word-boundary match: prevents false positives on "gemini-cli" or
      // paths like "/usr/lib/gemini-helper".
      const processRe = /(?:^|\/)gemini(?:\s|$)/;
      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        if (processRe.test(cols.slice(2).join(" "))) {
          return parseInt(cols[0] ?? "0", 10);
        }
      }
      return null;
    }

    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return pid;
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "EPERM") return pid;
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Terminal Output Classification (detectActivity fallback)
// =============================================================================

/**
 * Classify Gemini CLI activity from raw terminal output.
 *
 * Gemini CLI terminal patterns (as of v0.3x):
 * - REPL prompt: "gemini ❯ " or just "❯ " at end of output
 * - Active/thinking: spinner chars (⠋⠙⠹…), "Thinking", "Processing", "Reading"
 * - Permission prompt: "Do you want to proceed?", "(y/n)", tool approval lines
 * - Error: "Error:", "Failed:", API error messages
 */
function classifyGeminiOutput(terminalOutput: string): ActivityState {
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // REPL prompt visible → agent is idle and waiting for input
  if (/^(gemini\s+)?[❯>]\s*$/.test(lastLine)) return "idle";

  // Check bottom 5 lines for permission/approval prompts
  const tail = lines.slice(-5).join("\n");
  if (/do you want to proceed\?/i.test(tail)) return "waiting_input";
  if (/\(y(es)?\).*\(n(o)?\)/i.test(tail)) return "waiting_input";
  if (/approve|allow|deny|permission/i.test(tail)) return "waiting_input";

  // Non-recoverable error states
  if (/^(Error|Failed|Exception):/m.test(tail)) return "blocked";

  return "active";
}

// =============================================================================
// Workspace Hooks Setup
// =============================================================================

const HOOK_SCRIPT_RELATIVE = ".gemini/ao-metadata-updater.sh";

/**
 * Write the metadata updater script and register the hook in .gemini/settings.json.
 * Uses a relative path for the hook command so that symlinked .gemini/ directories
 * across worktrees all produce the same settings.json content (no last-writer clobber).
 * Also pre-trusts the hook in ~/.gemini/trusted_hooks.json to prevent Gemini from
 * showing its hooks trust warning dialog before the REPL is ready.
 */
async function writeGeminiHooks(workspacePath: string): Promise<void> {
  const scriptPath = join(workspacePath, HOOK_SCRIPT_RELATIVE);
  await mkdir(join(workspacePath, ".gemini"), { recursive: true });
  await writeFile(scriptPath, METADATA_UPDATER_SCRIPT, "utf-8");
  await chmod(scriptPath, 0o755);
  // Register using a relative path so symlinked worktrees share the same content.
  await setupHookInWorkspace(workspacePath, HOOK_SCRIPT_RELATIVE);
  // Pre-trust the hook so Gemini skips the hooks-trust warning dialog.
  await trustGeminiHook(workspacePath, "ao-metadata-updater", HOOK_SCRIPT_RELATIVE);
}

/**
 * Add an entry to ~/.gemini/trusted_hooks.json for the given workspace path
 * so that Gemini doesn't show its hooks-trust warning dialog before the REPL starts.
 * Format: { "<workspacePath>": ["<name>:<relativeScriptPath>", ...] }
 */
async function trustGeminiHook(
  workspacePath: string,
  hookName: string,
  hookScriptRelative: string,
): Promise<void> {
  const trustedHooksPath = join(homedir(), ".gemini", "trusted_hooks.json");
  let trusted: Record<string, string[]> = {};

  try {
    const raw = await readFile(trustedHooksPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      trusted = parsed as Record<string, string[]>;
    }
  } catch {
    // File doesn't exist yet or is malformed — start fresh
  }

  const entry = `${hookName}:${hookScriptRelative}`;
  const existing = Array.isArray(trusted[workspacePath]) ? trusted[workspacePath] : [];
  if (!existing.includes(entry)) {
    trusted[workspacePath] = [...existing, entry];
    await mkdir(join(homedir(), ".gemini"), { recursive: true });
    await writeFile(trustedHooksPath, JSON.stringify(trusted, null, 2) + "\n", "utf-8");
  }
}

/**
 * Write the AO metadata updater script and register it as an AfterTool hook
 * in the workspace's .gemini/settings.json.
 */
async function setupHookInWorkspace(workspacePath: string, hookScriptPath: string): Promise<void> {
  const geminiDir = join(workspacePath, ".gemini");
  const settingsPath = join(geminiDir, "settings.json");

  await mkdir(geminiDir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed settings.json — start fresh
    }
  }

  const hookEntry = {
    matcher: "run_shell_command",
    hooks: [
      {
        type: "command",
        name: "ao-metadata-updater",
        command: hookScriptPath,
        description: "Auto-updates AO session metadata on git/gh commands",
        timeout: 10_000,
      },
    ],
  };

  const existingHooks = settings["hooks"];
  const hooksObj: Record<string, unknown[]> =
    typeof existingHooks === "object" && existingHooks !== null && !Array.isArray(existingHooks)
      ? (existingHooks as Record<string, unknown[]>)
      : {};

  const afterToolHooks: unknown[] = Array.isArray(hooksObj["AfterTool"]) ? hooksObj["AfterTool"] : [];

  // Replace any existing ao-metadata-updater entry to avoid duplicates
  const filtered = afterToolHooks.filter((h) => {
    if (typeof h !== "object" || h === null) return true;
    const hooksArr = (h as Record<string, unknown>)["hooks"];
    if (!Array.isArray(hooksArr)) return true;
    return !hooksArr.some(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["name"] === "ao-metadata-updater",
    );
  });
  filtered.push(hookEntry);

  settings["hooks"] = { ...hooksObj, AfterTool: filtered };
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

// =============================================================================
// Agent Implementation
// =============================================================================

/**
 * Resolve the absolute path of the gemini binary.
 * Runs `which gemini` in the current process (the AO CLI), which has the
 * correct PATH (including nvm). The resolved absolute path is then used in
 * getLaunchCommand so that the tmux shell can find the binary even if nvm
 * isn't initialized in the tmux shell's PATH.
 */
function resolveGeminiBinarySync(): string {
  try {
    const result = spawnSync("which", ["gemini"], { encoding: "utf-8", timeout: 5_000 });
    const resolved = (result.stdout as string | null)?.trim();
    if (resolved) return resolved;
  } catch {
    // which not available or gemini not found
  }
  // Fallback: let the shell resolve it at runtime
  return "gemini";
}

function createGeminiAgent(): Agent {
  /**
   * Cached absolute path to the gemini binary (resolved once at creation time
   * from the CLI process PATH, which has nvm). Prevents the tmux shell — which
   * may not have nvm — from picking up a guard wrapper instead of the real CLI.
   */
  const resolvedBinary: string = resolveGeminiBinarySync();

  return {
    name: "gemini",
    processName: "gemini",

    /**
     * Use post-launch delivery so Gemini runs as an interactive REPL in tmux.
     * AO sends the task prompt after the agent starts via runtime.sendMessage().
     *
     * Using `-p` (non-interactive) would cause Gemini to exit immediately after
     * responding, which AO would interpret as the session being "killed".
     */
    promptDelivery: "post-launch" as const,

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = [shellEscape(resolvedBinary)];

      const permissionMode = normalizePermissionMode(config.permissions);
      if (permissionMode === "permissionless" || permissionMode === "auto-edit") {
        parts.push("--approval-mode=yolo");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.systemPromptFile) {
        // Gemini reads context from GEMINI.md in the project root.
        // There is no direct --system-prompt-file flag; the file's contents
        // are passed as a shell substitution so the shell expands them at
        // launch time without tmux truncation.
        parts.push("--system-prompt", `"$(cat ${shellEscape(config.systemPromptFile)})"`);
      } else if (config.systemPrompt) {
        parts.push("--system-prompt", shellEscape(config.systemPrompt));
      }

      // NOTE: prompt is NOT embedded here — AO sends it post-launch via
      // runtime.sendMessage() so Gemini stays in interactive REPL mode.

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyGeminiOutput(terminalOutput);
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      if (!session.runtimeHandle) return { state: "exited", timestamp: new Date() };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: new Date() };

      if (!session.workspacePath) return null;

      const chatsDir = getGeminiChatsDir(session.workspacePath);
      const latest = await findLatestSessionFileCached(chatsDir);

      if (!latest) {
        // Session file not yet created (agent just started) — fall back to
        // detectActivity via the lifecycle manager's fallback path.
        return null;
      }

      // Prefer lastUpdated from JSON — file mtime can drift on network filesystems.
      let activityTime = latest.mtime;
      const sessionData = await parseSessionFile(latest.path);
      if (sessionData?.lastUpdated) {
        const d = new Date(sessionData.lastUpdated);
        if (!isNaN(d.getTime())) activityTime = d;
      }

      const ageMs = Date.now() - activityTime.getTime();
      const activeWindow = Math.min(30_000, threshold);

      if (ageMs < activeWindow) return { state: "active", timestamp: activityTime };
      if (ageMs < threshold) return { state: "ready", timestamp: activityTime };
      return { state: "idle", timestamp: activityTime };
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      return (await findGeminiProcess(handle)) !== null;
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const chatsDir = getGeminiChatsDir(session.workspacePath);
      const latest = await findLatestSessionFileCached(chatsDir);
      if (!latest) return null;

      const sessionData = await parseSessionFile(latest.path);
      if (!sessionData) return null;

      let summary: string | null = null;
      let summaryIsFallback = false;

      if (sessionData.summary?.trim()) {
        summary = sessionData.summary.trim();
      } else {
        const fallback = extractFirstUserMessage(sessionData);
        if (fallback) {
          summary = fallback;
          summaryIsFallback = true;
        }
      }

      return {
        summary,
        summaryIsFallback,
        agentSessionId: sessionData.sessionId ?? null,
        cost: extractCost(sessionData),
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      const agentSessionId = session.agentInfo?.agentSessionId;
      if (!agentSessionId) return null;
      // AO will send the new task prompt via runtime.sendMessage after resuming,
      // so we only need the --resume flag here (no -p, stays interactive).
      return `${shellEscape(resolvedBinary)} --resume ${shellEscape(agentSessionId)}`;
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await writeGeminiHooks(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      // 1. Write hooks into the workspace (in case setupWorkspaceHooks wasn't called
      //    yet for this worktree — mirrors what claude-code does).
      if (session.workspacePath) {
        await writeGeminiHooks(session.workspacePath);
      }

      // 2. Wait for Gemini's REPL prompt (❯) to appear so the session manager's
      //    5-second fixed delay doesn't fire before Gemini is ready for input.
      //    Only possible when the runtime is tmux (we can capture the pane).
      const handle = session.runtimeHandle;
      if (
        !handle ||
        typeof handle !== "object" ||
        (handle as RuntimeHandle).runtimeName !== "tmux" ||
        !(handle as RuntimeHandle).id
      ) {
        return;
      }

      const tmuxTarget = (handle as RuntimeHandle).id;
      const POLL_INTERVAL_MS = 500;
      const TIMEOUT_MS = 30_000;
      const deadline = Date.now() + TIMEOUT_MS;

      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
          const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", tmuxTarget], {
            timeout: 5_000,
          });
          // Gemini REPL shows "gemini ❯ " or just "❯ " when ready
          if (/[❯>]\s*$/.test(stdout.trimEnd())) {
            return;
          }
          // Guard: if gemini exited immediately (guard script, not installed), bail out
          if (/gemini guard:|command not found|not installed/i.test(stdout)) {
            return;
          }
        } catch {
          // tmux not available or pane gone — proceed without readiness check
          return;
        }
      }
      // Timeout — Gemini didn't show REPL within 30s, proceed anyway
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createGeminiAgent();
}

export function detect(): boolean {
  try {
    execFileSync("gemini", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
