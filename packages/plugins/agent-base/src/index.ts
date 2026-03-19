import {
  shellEscape,
  readLastJsonlEntry,
  DEFAULT_READY_THRESHOLD_MS,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type CostEstimate,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { readdir, readFile, stat, open, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Plugin Config
// =============================================================================

/** Configuration that differentiates one JSONL-based agent plugin from another. */
export interface AgentPluginConfig {
  /** Plugin manifest name, e.g. "claude-code", "cursor", "gemini". */
  name: string;
  /** Human-readable description for the manifest. */
  description: string;
  /** Process name matched against `ps` output, e.g. "claude", "cursor-agent", "gemini". */
  processName: string;
  /** CLI binary to invoke, e.g. "claude", "cursor-agent", "gemini". */
  command: string;
  /**
   * Agent config directory under $HOME and under each workspace root.
   * e.g. ".claude" → sessions at ~/.claude/projects/, hooks at <workspace>/.claude/
   */
  configDir: string;
  /**
   * Flag appended for permissionless / auto-edit modes.
   * e.g. "--dangerously-skip-permissions" or "--yolo".
   */
  permissionlessFlag: string;
  /**
   * Flag prefix for supplying a system prompt at launch time.
   * Set to undefined if the CLI does not support system prompt flags
   * (prompts must be delivered post-launch via sendMessage instead).
   */
  systemPromptFlag?: string;
  /**
   * Fallback cost rates used when JSONL contains token counts but no direct
   * cost field. Units are USD per million tokens.
   */
  defaultCostRate?: {
    inputPerMillion: number;
    outputPerMillion: number;
  };
  /**
   * Environment variable used to pass a system prompt file path to the agent.
   * Set when the CLI uses an env var instead of a flag (e.g. "GEMINI_SYSTEM_MD").
   * Mutually exclusive with systemPromptFlag — set only one.
   */
  systemPromptEnvVar?: string;
  /**
   * Override the session directory path for a given workspace.
   * Defaults to `~/<configDir>/projects/<toAgentProjectPath(workspacePath)>`.
   * Override when the agent uses a different directory structure
   * (e.g. Gemini CLI uses `~/.gemini/tmp/<sha256>/chats/`).
   */
  getSessionDir?: (workspacePath: string) => string;
  /**
   * File extension for session files in the session directory.
   * Defaults to ".jsonl". Override for agents that use a different extension
   * (e.g. Gemini CLI uses ".json").
   */
  sessionFileExtension?: string;
  /**
   * Exact PostToolUse tool name to match against.
   * Defaults to "Bash". Override for agents that use different shell tools
   * (e.g. Gemini uses "run_shell_command").
   */
  hookToolMatcher?: string;
  /**
   * Hook event type to register. Defaults to "PostToolUse".
   * Override for agents that use different hook events
   * (e.g. Gemini uses "AfterTool").
   */
  hookEvent?: "PostToolUse" | "AfterTool";
  /**
   * Default data directory for session metadata.
   * Used by postLaunchSetup when hookConfig.dataDir is not available.
   * Defaults to "$HOME/.ao-sessions" if not provided.
   */
  defaultDataDir?: string;
}

// =============================================================================
// Metadata Updater Hook Script (shared across all JSONL-based agents)
// =============================================================================

export const METADATA_UPDATER_SCRIPT = `#!/usr/bin/env bash
# Metadata Updater Hook for Agent Orchestrator
#
# This PostToolUse hook automatically updates session metadata when:
# - gh pr create: extracts PR URL and writes to metadata
# - git checkout -b / git switch -c: extracts branch name and writes to metadata
# - gh pr merge: updates status to "merged"

set -euo pipefail

# Configuration
AO_DATA_DIR="\${AO_DATA_DIR:-$HOME/.ao-sessions}"

# Read hook input from stdin
input=$(cat)

# Extract fields from JSON (using jq if available, otherwise basic parsing)
if command -v jq &>/dev/null; then
  tool_name=$(echo "$input" | jq -r '.tool_name // empty')
  command=$(echo "$input" | jq -r '.tool_input.command // empty')
  output=$(echo "$input" | jq -r '.tool_response // empty')
  exit_code=$(echo "$input" | jq -r '.exit_code // 0')
else
  # Fallback: basic JSON parsing without jq
  tool_name=$(echo "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  command=$(echo "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  output=$(echo "$input" | grep -o '"tool_response"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  exit_code=$(echo "$input" | grep -o '"exit_code"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' || echo "0")
fi

# Only process successful commands (exit code 0)
if [[ "$exit_code" -ne 0 ]]; then
  echo '{}'
  exit 0
fi

# Only process shell tool calls from the configured matcher
# (Claude uses "Bash"; Gemini CLI uses "run_shell_command")
if [[ "$tool_name" != "__AO_HOOK_TOOL_MATCHER__" ]]; then
  echo '{}' # Empty JSON output
  exit 0
fi

# Validate AO_SESSION is set
if [[ -z "\${AO_SESSION:-}" ]]; then
  echo '{"systemMessage": "AO_SESSION environment variable not set, skipping metadata update"}'
  exit 0
fi

# Validate AO_SESSION to prevent path traversal attacks
if [[ "$AO_SESSION" == *"/"* ]] || [[ "$AO_SESSION" == *".."* ]]; then
  echo '{"systemMessage": "AO_SESSION contains invalid characters, skipping metadata update"}'
  exit 0
fi

# Construct metadata file path
# AO_DATA_DIR is already set to the project-specific sessions directory
metadata_file="$AO_DATA_DIR/$AO_SESSION"

# Ensure metadata file exists
if [[ ! -f "$metadata_file" ]]; then
  echo '{"systemMessage": "Metadata file not found: '"$metadata_file"'"}'
  exit 0
fi

# Update a single key in metadata
update_metadata_key() {
  local key="$1"
  local value="$2"

  # Create temp file with PID for atomic updates under concurrency
  local temp_file="\${metadata_file}.tmp.\$$"

  # Escape special sed characters in value (& | / \\)
  local escaped_value=$(echo "$value" | sed 's/[&|\\/]/\\\\&/g')

  # Check if key already exists
  if grep -q "^$key=" "$metadata_file" 2>/dev/null; then
    # Update existing key
    sed "s|^$key=.*|$key=$escaped_value|" "$metadata_file" > "$temp_file"
  else
    # Append new key
    cp "$metadata_file" "$temp_file"
    echo "$key=$value" >> "$temp_file"
  fi

  # Atomic replace
  mv "$temp_file" "$metadata_file"

  # Clean up only our own temp file (PID-specific to avoid race with concurrent hooks)
  rm -f "\${metadata_file}.tmp.\$$" 2>/dev/null || true
}

# ============================================================================
# Command Detection and Parsing
# ============================================================================

# Strip leading "cd /path && " prefix because agents often run:
#   cd ~/.worktrees/project && gh pr create ...
# Without this, the command matching below fails silently.
# Uses greedy .* to handle paths with spaces (e.g., cd "/path with spaces" && ...)
clean_command="$command"
cd_prefix_pattern='^[[:space:]]*cd[[:space:]]+.*[[:space:]]+(&&|;)[[:space:]]+(.*)'
while [[ "$clean_command" =~ $cd_prefix_pattern ]]; do
  clean_command="${BASH_REMATCH[2]}"
done

# Detect: gh pr create
if [[ "$clean_command" =~ ^gh[[:space:]]+pr[[:space:]]+create ]]; then
  # Extract PR URL from output
  pr_url=$(echo "$output" | grep -Eo 'https://github[.]com/[^/]+/[^/]+/pull/[0-9]+' | head -1)

  if [[ -n "$pr_url" ]]; then
    update_metadata_key "pr" "$pr_url"
    update_metadata_key "status" "pr_open"
    echo '{"systemMessage": "Updated metadata: PR created at '"$pr_url"'"}'
    exit 0
  fi
fi

# Detect: git checkout -b <branch> or git switch -c <branch>
if [[ "$clean_command" =~ ^git[[:space:]]+checkout[[:space:]]+-b[[:space:]]+([^[:space:]]+) ]] || \\
   [[ "$clean_command" =~ ^git[[:space:]]+switch[[:space:]]+-c[[:space:]]+([^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"

  if [[ -n "$branch" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: git checkout <branch> (without -b) or git switch <branch> (without -c)
# Only update if the branch name looks like a feature branch (contains / or -)
if [[ "$clean_command" =~ ^git[[:space:]]+checkout[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]] || \\
   [[ "$clean_command" =~ ^git[[:space:]]+switch[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"

  # Avoid updating for checkout of commits/tags
  if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: gh pr merge
if [[ "$clean_command" =~ ^gh[[:space:]]+pr[[:space:]]+merge ]]; then
  update_metadata_key "status" "merged"
  echo '{"systemMessage": "Updated metadata: status = merged"}'
  exit 0
fi

# No matching command, exit silently
echo '{}'
exit 0
`;

const HOOK_TOOL_MATCHER_PLACEHOLDER = "__AO_HOOK_TOOL_MATCHER__";

// =============================================================================
// Project Path Encoding
// =============================================================================

/**
 * Convert a workspace path to an agent's project directory path.
 *
 * Most JSONL-based agents (Claude Code and Cursor) use the same encoding:
 * the path replaces / and . with -, including the leading slash.
 * e.g. /Users/dev/.worktrees/ao → -Users-dev--worktrees-ao.
 * Agents with custom layouts (for example Gemini) override getSessionDir.
 *
 * If an agent changes its encoding scheme this will silently break
 * introspection. The path can be validated at runtime by checking whether
 * the resulting directory exists.
 *
 * Exported for testing purposes.
 */
export function toAgentProjectPath(workspacePath: string): string {
  // Handle Windows drive letters (C:\Users\... → C-Users-...)
  const normalized = workspacePath.replace(/\\/g, "/");
  // Replace / and . with - (including leading slash as a leading -)
  return normalized.replace(/:/g, "").replace(/[/.]/g, "-");
}

// =============================================================================
// JSONL Helpers
// =============================================================================

/** Find the most recently modified session file in a directory */
async function findLatestSessionFile(
  projectDir: string,
  ext = ".jsonl",
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  const jsonlFiles = entries.filter((f) => f.endsWith(ext) && !f.startsWith("agent-"));
  if (jsonlFiles.length === 0) return null;

  // Sort by mtime descending
  const withStats = await Promise.all(
    jsonlFiles.map(async (f) => {
      const fullPath = join(projectDir, f);
      try {
        const s = await stat(fullPath);
        return { path: fullPath, mtime: s.mtimeMs };
      } catch {
        return { path: fullPath, mtime: 0 };
      }
    }),
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats[0]?.path ?? null;
}

interface JsonlLine {
  type?: string;
  summary?: string;
  message?: { content?: string; role?: string };
  // Cost/usage fields
  costUSD?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * Parse only the last `maxBytes` of a JSONL file.
 * Summaries and recent activity are always near the end, so reading the whole
 * file (which can be 100MB+) is wasteful. For files smaller than maxBytes,
 * readFile is used directly. For large files, only the tail is read via a
 * file handle to avoid loading the entire file into memory.
 */
async function parseJsonlFileTail(filePath: string, maxBytes = 131_072): Promise<JsonlLine[]> {
  let content: string;
  let offset: number;
  try {
    const { size = 0 } = await stat(filePath);
    offset = Math.max(0, size - maxBytes);
    if (offset === 0) {
      // Small file (or unknown size) — read it whole
      content = await readFile(filePath, "utf-8");
    } else {
      // Large file — read only the tail via a file handle
      const handle = await open(filePath, "r");
      try {
        const length = size - offset;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        content = buffer.slice(0, bytesRead).toString("utf-8");
      } finally {
        await handle.close();
      }
    }
  } catch {
    return [];
  }
  // Skip potentially truncated first line only when we started mid-file.
  // If offset === 0 we read from the start so the first line is complete.
  const firstNewline = content.indexOf("\n");
  const safeContent =
    offset > 0 && firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
  const lines: JsonlLine[] = [];
  for (const line of safeContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        lines.push(parsed as JsonlLine);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

function escapeHookMatcherForBash(matcher: string): string {
  return matcher.replace(/\\/g, "\\\\").replace(/["$]/g, "\\$&");
}

/** Extract auto-generated summary from JSONL (last "summary" type entry) */
function extractSummary(
  lines: JsonlLine[],
): { summary: string; isFallback: boolean } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.type === "summary" && line.summary) {
      return { summary: line.summary, isFallback: false };
    }
  }
  // Fallback: first user message truncated to 120 chars
  for (const line of lines) {
    if (
      line?.type === "user" &&
      line.message?.content &&
      typeof line.message.content === "string"
    ) {
      const msg = line.message.content.trim();
      if (msg.length > 0) {
        return {
          summary: msg.length > 120 ? msg.substring(0, 120) + "..." : msg,
          isFallback: true,
        };
      }
    }
  }
  return null;
}

/** Aggregate cost estimate from JSONL usage events */
function extractCost(
  lines: JsonlLine[],
  defaultCostRate: AgentPluginConfig["defaultCostRate"],
): CostEstimate | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;

  for (const line of lines) {
    // Handle direct cost fields — prefer costUSD; only use estimatedCostUsd
    // as fallback to avoid double-counting when both are present.
    if (typeof line.costUSD === "number") {
      totalCost += line.costUSD;
    } else if (typeof line.estimatedCostUsd === "number") {
      totalCost += line.estimatedCostUsd;
    }
    // Handle token counts — prefer the structured `usage` object when present;
    // only fall back to flat `inputTokens`/`outputTokens` fields to avoid
    // double-counting if a line contains both.
    if (line.usage) {
      inputTokens += line.usage.input_tokens ?? 0;
      inputTokens += line.usage.cache_read_input_tokens ?? 0;
      inputTokens += line.usage.cache_creation_input_tokens ?? 0;
      outputTokens += line.usage.output_tokens ?? 0;
    } else {
      if (typeof line.inputTokens === "number") {
        inputTokens += line.inputTokens;
      }
      if (typeof line.outputTokens === "number") {
        outputTokens += line.outputTokens;
      }
    }
  }

  if (inputTokens === 0 && outputTokens === 0 && totalCost === 0) {
    return undefined;
  }

  // Rough estimate when no direct cost data — use the configured rate.
  if (totalCost === 0 && defaultCostRate && (inputTokens > 0 || outputTokens > 0)) {
    totalCost =
      (inputTokens / 1_000_000) * defaultCostRate.inputPerMillion +
      (outputTokens / 1_000_000) * defaultCostRate.outputPerMillion;
  }

  return { inputTokens, outputTokens, estimatedCostUsd: totalCost };
}

// =============================================================================
// Process Detection
// =============================================================================

/**
 * TTL cache for `ps -eo pid,tty,args` output. Without this, listing N sessions
 * would spawn N concurrent `ps` processes, each taking 30+ seconds on machines
 * with many processes. The cache ensures `ps` is called at most once per TTL
 * window regardless of how many sessions are being enriched.
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
    // Cache hit — return resolved output or wait for in-flight request
    if (psCache.promise) return psCache.promise;
    return psCache.output;
  }

  // Cache miss or expired — start a single `ps` call and share the promise.
  // Guard both callbacks so they only update psCache if it still belongs to
  // this request — a newer request may have replaced it while we were waiting.
  const promise = execFileAsync("ps", ["-eo", "pid,tty,args"], {
    timeout: 30_000,
  }).then(({ stdout }) => {
    if (psCache?.promise === promise) {
      psCache = { output: stdout, timestamp: Date.now() };
    }
    return stdout;
  });

  // Store the in-flight promise so concurrent callers share it
  psCache = { output: "", timestamp: now, promise };

  try {
    return await promise;
  } catch {
    // On failure, clear cache so the next caller retries — but only if
    // psCache still points to this request (avoid clobbering a newer entry)
    if (psCache?.promise === promise) {
      psCache = null;
    }
    return "";
  }
}

/**
 * Check if the configured agent process is running in the given runtime handle's context.
 * Uses ps to find processes by TTY (for tmux) or by PID.
 */
async function findAgentProcess(
  handle: RuntimeHandle,
  processRe: RegExp,
): Promise<number | null> {
  try {
    // For tmux runtime, get the pane TTY and find the process on it
    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync(
        "tmux",
        ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
        { timeout: 5_000 },
      );
      // Iterate all pane TTYs (multi-pane sessions) — succeed on any match
      const ttys = ttyOut
        .trim()
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      if (ttys.length === 0) return null;

      const psOut = await getCachedProcessList();
      if (!psOut) return null;

      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
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
        process.kill(pid, 0); // Signal 0 = check existence
        return pid;
      } catch (err: unknown) {
        // EPERM means the process exists but we lack permission to signal it
        if (err instanceof Error && "code" in err && err.code === "EPERM") {
          return pid;
        }
        return null;
      }
    }

    // No reliable way to identify the correct process for this session
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Terminal Output Patterns for detectActivity
// =============================================================================

/** Classify agent activity state from terminal output (pure, sync). */
function classifyTerminalOutput(terminalOutput: string): ActivityState {
  // Empty output — can't determine state
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // Check the last line FIRST — if the prompt is visible, the agent is idle
  // regardless of historical output (e.g. "Reading file..." from earlier).
  if (/^[❯>$#]\s*$/.test(lastLine)) return "idle";

  // Check the bottom of the buffer for permission prompts BEFORE checking
  // full-buffer active indicators. Historical "Thinking"/"Reading" text in
  // the buffer must not override a current permission prompt at the bottom.
  const tail = lines.slice(-5).join("\n");
  if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";
  if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
  if (/bypass.*permissions/i.test(tail)) return "waiting_input";

  // Everything else is "active" — the agent is processing, waiting for
  // output, or showing content.
  return "active";
}

// =============================================================================
// Hook Setup Helper
// =============================================================================

/**
 * Shared helper to setup PostToolUse hooks in a workspace.
 * Writes metadata-updater.sh script and updates settings.json.
 */
async function setupHookInWorkspace(
  workspacePath: string,
  configDir: string,
  hookCommand: string,
  hookMatcher = "Bash",
  hookEvent: "PostToolUse" | "AfterTool" = "PostToolUse",
): Promise<void> {
  const agentDir = join(workspacePath, configDir);
  const settingsPath = join(agentDir, "settings.json");
  const hookScriptPath = join(agentDir, "metadata-updater.sh");

  // Create config directory if it doesn't exist
  try {
    await mkdir(agentDir, { recursive: true });
  } catch {
    // Directory might already exist
  }

  // Write the metadata updater script
  await writeFile(
    hookScriptPath,
    METADATA_UPDATER_SCRIPT.replace(
      HOOK_TOOL_MATCHER_PLACEHOLDER,
      escapeHookMatcherForBash(hookMatcher),
    ),
    "utf-8",
  );
  await chmod(hookScriptPath, 0o755); // Make executable

  // Read existing settings if present
  let existingSettings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const content = await readFile(settingsPath, "utf-8");
      existingSettings = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Invalid JSON or read error — start fresh
    }
  }

  // Merge hooks configuration — type-guard before casting to avoid runtime
  // errors on malformed or older settings.json files
  const rawHooks = existingSettings["hooks"];
  const hooks: Record<string, unknown> =
    typeof rawHooks === "object" && rawHooks !== null && !Array.isArray(rawHooks)
      ? (rawHooks as Record<string, unknown>)
      : {};
  // Read from the correct hook event key (PostToolUse or AfterTool)
  const rawHookArray = hooks[hookEvent];
  const hookArray: Array<unknown> = Array.isArray(rawHookArray) ? rawHookArray : [];

  // Check if our hook is already configured
  let hookIndex = -1;
  let hookDefIndex = -1;
  for (let i = 0; i < hookArray.length; i++) {
    const hook = hookArray[i];
    if (typeof hook !== "object" || hook === null || Array.isArray(hook)) continue;
    const h = hook as Record<string, unknown>;
    const hooksList = h["hooks"];
    if (!Array.isArray(hooksList)) continue;
    for (let j = 0; j < hooksList.length; j++) {
      const hDef = hooksList[j];
      if (typeof hDef !== "object" || hDef === null || Array.isArray(hDef)) continue;
      const def = hDef as Record<string, unknown>;
      if (typeof def["command"] === "string" && def["command"].includes("metadata-updater.sh")) {
        hookIndex = i;
        hookDefIndex = j;
        break;
      }
    }
    if (hookIndex >= 0) break;
  }

  // Add or update our hook
  if (hookIndex === -1) {
    // No metadata hook exists, add it
    hookArray.push({
      matcher: hookMatcher,
      hooks: [
        {
          type: "command",
          command: hookCommand,
          timeout: 5000,
        },
      ],
    });
  } else {
    const hook = hookArray[hookIndex] as Record<string, unknown>;
    hook["matcher"] = hookMatcher;

    // Hook exists, update the command — but preserve an existing AO_DATA_DIR
    // prefix if the new command doesn't include one (e.g. postLaunchSetup
    // doesn't have access to hookConfig.dataDir and would silently drop it).
    const hooksList = hook["hooks"] as Array<Record<string, unknown>>;
    const existingCommand = hooksList[hookDefIndex]["command"] as string | undefined;
    const newCommandDropsDataDir =
      !hookCommand.includes("AO_DATA_DIR=") &&
      typeof existingCommand === "string" &&
      existingCommand.includes("AO_DATA_DIR=");
    if (!newCommandDropsDataDir) {
      hooksList[hookDefIndex]["command"] = hookCommand;
    }
  }

  hooks[hookEvent] = hookArray;
  existingSettings["hooks"] = hooks;

  // Write updated settings
  await writeFile(settingsPath, JSON.stringify(existingSettings, null, 2) + "\n", "utf-8");
}

// =============================================================================
// Agent Factory
// =============================================================================

/**
 * Create a JSONL-based agent plugin given a configuration object.
 * All agent-specific constants (process name, CLI flags, config directory,
 * pricing) are injected via `config`; the implementation logic is shared.
 *
 * Pass `overrides` to replace specific methods — useful for agents that use
 * a different session format (e.g. Cursor's SQLite storage instead of JSONL).
 */
export function createAgentPlugin(config: AgentPluginConfig, overrides?: Partial<Agent>): Agent {
  // Escape regex metacharacters in processName to prevent injection (e.g., "gemini+" would match "gemini" and "+").
  const escapedProcessName = config.processName.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
  // Build process regex once — matches the process name as a word boundary
  // to prevent false positives (e.g. "gemini-pro" matching "gemini").
  const processRe = new RegExp(`(?:^|/)${escapedProcessName}(?:\\s|$)`);

  return {
    name: config.name,
    processName: config.processName,
    promptDelivery: "post-launch",

    getLaunchCommand(launchConfig: AgentLaunchConfig): string {
      const parts: string[] = [config.command];

      const permissionMode = normalizePermissionMode(launchConfig.permissions);
      if (permissionMode === "permissionless" || permissionMode === "auto-edit") {
        parts.push(config.permissionlessFlag);
      }

      if (launchConfig.model) {
        parts.push("--model", shellEscape(launchConfig.model));
      }

      if (config.systemPromptFlag) {
        if (launchConfig.systemPromptFile) {
          // Use shell command substitution to read from file at launch time.
          // This avoids tmux truncation when inlining 2000+ char prompts.
          parts.push(
            config.systemPromptFlag,
            `"$(cat ${shellEscape(launchConfig.systemPromptFile)})"`,
          );
        } else if (launchConfig.systemPrompt) {
          parts.push(config.systemPromptFlag, shellEscape(launchConfig.systemPrompt));
        }
      }

      // NOTE: prompt is NOT included here — it's delivered post-launch via
      // runtime.sendMessage() to keep the agent in interactive mode.
      // Using -p / --prompt causes one-shot mode (agent exits after responding).

      return parts.join(" ");
    },

    getEnvironment(launchConfig: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};

      // Unset CLAUDECODE to avoid nested agent conflicts
      env["CLAUDECODE"] = "";

      // Set session info for introspection
      env["AO_SESSION"] = launchConfig.sessionId;
      env["AO_SESSION_ID"] = launchConfig.sessionId;

      // NOTE: AO_PROJECT_ID is NOT set here - it's the caller's responsibility
      // to set it based on their metadata path scheme.

      if (launchConfig.issueId) {
        env["AO_ISSUE_ID"] = launchConfig.issueId;
      }

      // Handle system prompt via environment variable (e.g. GEMINI_SYSTEM_MD).
      // Used for agents that don't support a system prompt CLI flag.
      if (config.systemPromptEnvVar) {
        if (launchConfig.systemPromptFile) {
          env[config.systemPromptEnvVar] = launchConfig.systemPromptFile;
        } else if (launchConfig.systemPrompt) {
          // Write the inline prompt to a temp file — env vars can't inline multi-KB prompts.
          const tmpDir = join(homedir(), ".ao-sessions", "tmp");
          const tmpFile = join(tmpDir, `system-${launchConfig.sessionId}.md`);
          try {
            mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
            writeFileSync(tmpFile, launchConfig.systemPrompt, { encoding: "utf-8", mode: 0o600 });
            env[config.systemPromptEnvVar] = tmpFile;
          } catch {
            // Could not write temp file — leave env var unset so the agent
            // falls back to its built-in defaults.
          }
        }
      }

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyTerminalOutput(terminalOutput);
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      const pid = await findAgentProcess(handle, processRe);
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

      // Process is running - check JSONL session file for activity
      if (!session.workspacePath) {
        // No workspace path — cannot determine activity without it
        return null;
      }

      const projectDir = config.getSessionDir
        ? config.getSessionDir(session.workspacePath)
        : join(homedir(), config.configDir, "projects", toAgentProjectPath(session.workspacePath));

      const sessionFile = await findLatestSessionFile(projectDir, config.sessionFileExtension);
      if (!sessionFile) {
        // No session file found — cannot determine activity
        return null;
      }

      const entry = await readLastJsonlEntry(sessionFile);
      if (!entry) {
        // Empty file or read error — cannot determine activity
        return null;
      }

      const ageMs = Date.now() - entry.modifiedAt.getTime();
      const timestamp = entry.modifiedAt;

      switch (entry.lastType) {
        case "user":
        case "tool_use":
        case "progress":
          return { state: ageMs > threshold ? "idle" : "active", timestamp };

        case "assistant":
        case "system":
        case "summary":
        case "result":
          return { state: ageMs > threshold ? "idle" : "ready", timestamp };

        case "permission_request":
          return { state: "waiting_input", timestamp };

        case "error":
          return { state: "blocked", timestamp };

        default:
          return { state: ageMs > threshold ? "idle" : "active", timestamp };
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const projectDir = config.getSessionDir
        ? config.getSessionDir(session.workspacePath)
        : join(homedir(), config.configDir, "projects", toAgentProjectPath(session.workspacePath));

      // Find the latest session JSONL file
      const sessionFile = await findLatestSessionFile(projectDir, config.sessionFileExtension);
      if (!sessionFile) return null;

      // Parse only the tail — summaries are always near the end, files can be 100MB+
      const lines = await parseJsonlFileTail(sessionFile);
      if (lines.length === 0) return null;

      // Extract session ID from filename
      const agentSessionId = basename(sessionFile, config.sessionFileExtension ?? ".jsonl");

      const summaryResult = extractSummary(lines);
      return {
        summary: summaryResult?.summary ?? null,
        summaryIsFallback: summaryResult?.isFallback,
        agentSessionId,
        cost: extractCost(lines, config.defaultCostRate),
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      const projectDir = config.getSessionDir
        ? config.getSessionDir(session.workspacePath)
        : join(homedir(), config.configDir, "projects", toAgentProjectPath(session.workspacePath));

      // Find the latest session JSONL file
      const sessionFile = await findLatestSessionFile(projectDir, config.sessionFileExtension);
      if (!sessionFile) return null;

      // Extract session UUID from filename (e.g. "abc123-def456.jsonl" → "abc123-def456")
      const sessionUuid = basename(sessionFile, config.sessionFileExtension ?? ".jsonl");
      if (!sessionUuid) return null;

      // Build resume command
      const parts: string[] = [config.command, "--resume", shellEscape(sessionUuid)];

      const permissionMode = normalizePermissionMode(project.agentConfig?.permissions);
      if (permissionMode === "permissionless" || permissionMode === "auto-edit") {
        parts.push(config.permissionlessFlag);
      }

      if (project.agentConfig?.model) {
        parts.push("--model", shellEscape(project.agentConfig.model as string));
      }

      return parts.join(" ");
    },

    async setupWorkspaceHooks(
      workspacePath: string,
      hookConfig: WorkspaceHooksConfig,
    ): Promise<void> {
      const hookScriptPath = join(workspacePath, config.configDir, "metadata-updater.sh");
      // Prefix AO_DATA_DIR so the hook writes to the configured data directory
      // rather than the default $HOME/.ao-sessions.
      const hookCommand = `AO_DATA_DIR=${shellEscape(hookConfig.dataDir)} ${shellEscape(hookScriptPath)}`;
      await setupHookInWorkspace(workspacePath, config.configDir, hookCommand, config.hookToolMatcher ?? "Bash", config.hookEvent ?? "PostToolUse");
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      const hookScriptPath = join(
        session.workspacePath,
        config.configDir,
        "metadata-updater.sh",
      );
      // postLaunchSetup does not receive hookConfig — use config.defaultDataDir or environment default
      const dataDir = config.defaultDataDir ?? join(homedir(), ".ao-sessions");
      const hookCommand = `AO_DATA_DIR=${shellEscape(dataDir)} ${shellEscape(hookScriptPath)}`;
      await setupHookInWorkspace(session.workspacePath, config.configDir, hookCommand, config.hookToolMatcher ?? "Bash", config.hookEvent ?? "PostToolUse");
    },

    ...overrides,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Normalize an agent permission mode string to a canonical value.
 * Maps the legacy "skip" alias to "permissionless"; returns undefined for
 * unrecognised or missing values.
 */
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
