import {
  shellEscape,
  DEFAULT_READY_THRESHOLD_MS,
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
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "auggie",
  slot: "agent" as const,
  description: "Agent plugin: Auggie (Augment CLI)",
  version: "0.1.0",
};

// =============================================================================
// Auggie Session File Types
// =============================================================================

/** Shape of a single chat history exchange in Auggie's session JSON */
interface AuggieChatEntry {
  exchange?: {
    request_message?: string;
    response_text?: string;
  };
  completed?: boolean;
  sequenceId?: number;
  finishedAt?: string;
  changedFiles?: string[];
  source?: string;
}

/** Shape of Auggie's session JSON file (~/.augment/sessions/{uuid}.json) */
interface AuggieSessionFile {
  sessionId?: string;
  created?: string;
  modified?: string;
  chatHistory?: AuggieChatEntry[];
  agentState?: {
    modelId?: string;
    userEmail?: string;
  };
  customTitle?: string;
  terminalId?: string;
  rootTaskUuid?: string;
}

// =============================================================================
// Metadata Updater Hook Script
// =============================================================================

/** Hook script content that updates session metadata on git/gh commands.
 * Identical purpose to the Claude Code metadata-updater — detects git/gh
 * commands and writes PR URLs, branch names, etc. to orchestrator metadata.
 *
 * Auggie's PostToolUse hook pipes JSON to stdin with:
 *   tool_name, tool_input, tool_output, file_changes
 */
const METADATA_UPDATER_SCRIPT = `#!/usr/bin/env bash
# Metadata Updater Hook for Agent Orchestrator (Auggie)
#
# This PostToolUse hook automatically updates session metadata when:
# - gh pr create: extracts PR URL and writes to metadata
# - git checkout -b / git switch -c: extracts branch name
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
  output=$(echo "$input" | jq -r '.tool_output // empty')
  exit_code=$(echo "$input" | jq -r '.exit_code // 0')
else
  tool_name=$(echo "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  command=$(echo "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  output=$(echo "$input" | grep -o '"tool_output"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  exit_code=$(echo "$input" | grep -o '"exit_code"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' || echo "0")
fi

# Only process successful commands (exit code 0)
if [[ "$exit_code" -ne 0 ]]; then
  echo '{}'
  exit 0
fi

# Only process launch-process tool calls (Auggie's equivalent of Bash)
if [[ "$tool_name" != "launch-process" ]]; then
  echo '{}'
  exit 0
fi

# Validate AO_SESSION is set
if [[ -z "\${AO_SESSION:-}" ]]; then
  echo '{"systemMessage": "AO_SESSION environment variable not set, skipping metadata update"}'
  exit 0
fi

# Construct metadata file path
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
  local temp_file="\${metadata_file}.tmp"
  local escaped_value=$(echo "$value" | sed 's/[&|\\/]/\\\\&/g')

  if grep -q "^$key=" "$metadata_file" 2>/dev/null; then
    sed "s|^$key=.*|$key=$escaped_value|" "$metadata_file" > "$temp_file"
  else
    cp "$metadata_file" "$temp_file"
    echo "$key=$value" >> "$temp_file"
  fi
  mv "$temp_file" "$metadata_file"
}

# ============================================================================
# Strip leading cd prefixes (e.g. "cd /workspace && gh pr create ...")
# Agents frequently cd into a worktree before running commands.
# ============================================================================
cd_prefix_pattern='^[[:space:]]*cd[[:space:]]+.*[[:space:]]+(&&|;)[[:space:]]+(.*)'
clean_command="$command"
while [[ "$clean_command" =~ ^[[:space:]]*cd[[:space:]] ]]; do
  if [[ "$clean_command" =~ $cd_prefix_pattern ]]; then
    clean_command="\${BASH_REMATCH[2]}"
  else
    break
  fi
done

# Detect: gh pr create
if [[ "$clean_command" =~ ^gh[[:space:]]+pr[[:space:]]+create ]]; then
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
if [[ "$clean_command" =~ ^git[[:space:]]+checkout[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]] || \\
   [[ "$clean_command" =~ ^git[[:space:]]+switch[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"
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

// =============================================================================
// Auggie Session Helpers
// =============================================================================

/** Default path where Auggie stores session files */
function getAuggieSessionsDir(): string {
  return join(homedir(), ".augment", "sessions");
}

/**
 * Find the Auggie session file that matches a given TTY.
 * Auggie stores `terminalId` (e.g. "/dev/ttys003") in each session JSON.
 * We match against the runtime handle's TTY to find the right session.
 */
async function findSessionByTty(tty: string): Promise<AuggieSessionFile | null> {
  const sessionsDir = getAuggieSessionsDir();
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return null;
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json"));

  // Collect all matching sessions, then pick the most recently modified.
  // TTYs can be reused (e.g. tmux pane destroyed and reallocated the same
  // /dev/pts/N), so a stale session file could match. Sorting by modified
  // timestamp ensures we return the current session, not a stale one.
  const candidates: AuggieSessionFile[] = [];

  for (const file of jsonFiles) {
    try {
      const content = await readFile(join(sessionsDir, file), "utf-8");
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const session = parsed as AuggieSessionFile;
      if (session.terminalId === tty) {
        candidates.push(session);
      }
    } catch {
      // Skip malformed files
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  // Sort by modified timestamp descending — most recent first
  candidates.sort((a, b) => {
    const aTime = a.modified ? new Date(a.modified).getTime() : 0;
    const bTime = b.modified ? new Date(b.modified).getTime() : 0;
    return bTime - aTime;
  });

  return candidates[0]!;
}

/**
 * Get the TTY for a tmux session pane.
 */
async function getTtyForHandle(handle: RuntimeHandle): Promise<string | null> {
  if (handle.runtimeName === "tmux" && handle.id) {
    try {
      const { stdout } = await execFileAsync(
        "tmux",
        ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
        { timeout: 5_000 },
      );
      const ttys = stdout
        .trim()
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      return ttys[0] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Find the Auggie session for an orchestrator session by matching TTY.
 */
async function findAuggieSession(session: Session): Promise<AuggieSessionFile | null> {
  if (!session.runtimeHandle) return null;

  const tty = await getTtyForHandle(session.runtimeHandle);
  if (!tty) return null;

  return findSessionByTty(tty);
}

// =============================================================================
// Process Detection
// =============================================================================

// TODO: getCachedProcessList / findProcess logic is duplicated from
// agent-claude-code. Extract to @composio/ao-core as a shared utility
// so both plugins share a single ps cache in the same process.

/** TTL cache for `ps` output — avoids spawning N `ps` processes for N sessions */
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
 * Check if an "auggie" process is running on the given runtime handle's TTY or PID.
 */
async function findAuggieProcess(handle: RuntimeHandle): Promise<number | null> {
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
      // Match "auggie" as a command — prevent false positives
      const processRe = /(?:^|\/)auggie(?:\s|$)/;
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

/** Classify Auggie's activity state from terminal output (pure, sync). */
function classifyTerminalOutput(terminalOutput: string): ActivityState {
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");

  // Check the tail for status bar and permission patterns.
  const tail = lines.slice(-10).join("\n");

  // Check for permission/input prompts first — these take priority
  if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";
  if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
  if (/\[y\/n\]/i.test(tail)) return "waiting_input";
  if (/\[[1-4]\]|Press 1\/2\/3\/4/i.test(tail)) return "waiting_input";
  if (/\[Enter\] Confirm/i.test(tail)) return "waiting_input";

  // Check for "? to show shortcuts" — Auggie's idle status bar indicator.
  // This only appears when Auggie is at the prompt, never during processing.
  if (/\? to show shortcuts/i.test(tail)) return "idle";

  // Check the last non-empty line for a prompt character.
  // Only check the LAST non-empty line to avoid matching a stale prompt
  // that remains in the buffer while the agent is actively processing below it.
  let lastNonEmpty = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim().length > 0) {
      lastNonEmpty = lines[i]!.trim();
      break;
    }
  }
  if (/^[›❯>$#]\s*$/.test(lastNonEmpty)) return "idle";

  return "active";
}


// =============================================================================
// Hook Setup Helper
// =============================================================================

/**
 * Set up PostToolUse hooks in Auggie's workspace-level settings.
 * Writes to <workspace>/.augment/settings.local.json (gitignored, non-intrusive).
 * The hook script is always written to <workspace>/.augment/metadata-updater.sh
 * and the settings reference that same path — no separate hookCommand parameter
 * to avoid path mismatches.
 */
async function setupHookInWorkspace(workspacePath: string): Promise<void> {
  const augmentDir = join(workspacePath, ".augment");
  const settingsPath = join(augmentDir, "settings.local.json");
  const hookScriptPath = join(augmentDir, "metadata-updater.sh");

  // Create .augment directory if it doesn't exist
  try {
    await mkdir(augmentDir, { recursive: true });
  } catch {
    // Directory might already exist
  }

  // Write the metadata updater script
  await writeFile(hookScriptPath, METADATA_UPDATER_SCRIPT, "utf-8");
  await chmod(hookScriptPath, 0o755);

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

  // Merge hooks configuration
  const hooks = (existingSettings["hooks"] as Record<string, unknown>) ?? {};
  const postToolUse = (hooks["PostToolUse"] as Array<unknown>) ?? [];

  // Check if our hook is already configured
  let hookIndex = -1;
  let hookDefIndex = -1;
  for (let i = 0; i < postToolUse.length; i++) {
    const hook = postToolUse[i];
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
    postToolUse.push({
      matcher: "launch-process",
      hooks: [
        {
          type: "command",
          command: hookScriptPath,
          timeout: 5000,
        },
      ],
    });
  } else {
    const hook = postToolUse[hookIndex] as Record<string, unknown>;
    const hooksList = hook["hooks"] as Array<Record<string, unknown>>;
    hooksList[hookDefIndex]["command"] = hookScriptPath;
  }

  hooks["PostToolUse"] = postToolUse;
  existingSettings["hooks"] = hooks;

  await writeFile(settingsPath, JSON.stringify(existingSettings, null, 2) + "\n", "utf-8");
}


// =============================================================================
// Agent Implementation
// =============================================================================

function createAuggieAgent(): Agent {
  return {
    name: "auggie",
    processName: "auggie",
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["auggie"];

      // Always pass workspace root explicitly for defensive indexing
      if (config.projectConfig?.path) {
        parts.push("--workspace-root", shellEscape(config.projectConfig.path));
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      // Log warning if permissions: skip is set — not applicable for Auggie
      if (config.permissions === "skip") {
        // permissions: skip has no effect for auggie — configure permissions
        // in ~/.augment/settings.json or <workspace>/.augment/settings.local.json
      }

      // Pass rules file if specified (agentRulesFile is a top-level ProjectConfig property)
      if (config.projectConfig?.agentRulesFile) {
        const rulesPath = join(
          config.projectConfig.path,
          config.projectConfig.agentRulesFile,
        );
        parts.push("--rules", shellEscape(rulesPath));
      }

      // NOTE: prompt is NOT included here — delivered post-launch via
      // runtime.sendMessage() to keep Auggie in interactive mode.
      // Using --print causes one-shot mode (Auggie exits after responding).

      // TODO: Support --add-workspace for multi-repo setups

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
      const pid = await findAuggieProcess(handle);
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

      // Process is running — check Auggie session file for activity
      const auggieSession = await findAuggieSession(session);
      if (!auggieSession) {
        // No session file found — cannot determine activity from files
        return null;
      }

      const chatHistory = auggieSession.chatHistory ?? [];
      if (chatHistory.length === 0) {
        // No chat history yet — agent just started
        return { state: "active", timestamp: new Date() };
      }

      const lastEntry = chatHistory[chatHistory.length - 1];
      if (!lastEntry) return null;

      // Use the session file's modified timestamp for age calculation
      const modifiedAt = auggieSession.modified
        ? new Date(auggieSession.modified)
        : new Date();
      const ageMs = Date.now() - modifiedAt.getTime();

      // completed === false or undefined means agent is still processing.
      // undefined occurs when Auggie writes a new chat entry before setting
      // the completed field — treat as active to avoid premature dispatch.
      if (lastEntry.completed !== true) {
        return { state: "active", timestamp: modifiedAt };
      }

      // completed === true — agent finished this exchange
      if (ageMs > threshold) {
        return { state: "idle", timestamp: modifiedAt };
      }

      return { state: "ready", timestamp: modifiedAt };
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      const auggieSession = await findAuggieSession(session);
      if (!auggieSession) return null;

      const agentSessionId = auggieSession.sessionId ?? null;

      // Summary: prefer customTitle, fall back to last response_text truncated
      let summary: string | null = auggieSession.customTitle ?? null;
      let summaryIsFallback = false;

      if (!summary) {
        const chatHistory = auggieSession.chatHistory ?? [];
        for (let i = chatHistory.length - 1; i >= 0; i--) {
          const entry = chatHistory[i];
          const responseText = entry?.exchange?.response_text;
          if (responseText && responseText.trim().length > 0) {
            summary =
              responseText.length > 120
                ? responseText.substring(0, 120) + "..."
                : responseText;
            summaryIsFallback = true;
            break;
          }
        }
      }

      // Cost tracking: Auggie uses credit-based pricing, not token-based.
      // --show-credits only works in non-interactive (--print) mode, and the
      // session file fields (creditUsage, subAgentCreditsUsed) are undocumented
      // and unreliably populated. Return undefined until a per-session cost API
      // is available.

      return {
        summary,
        summaryIsFallback,
        agentSessionId,
        cost: undefined,
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      // Find the Auggie session to get its UUID for --resume
      const auggieSession = await findAuggieSession(session);
      if (!auggieSession?.sessionId) return null;

      // Simple restore: auggie --resume <sessionId>
      return `auggie --resume ${shellEscape(auggieSession.sessionId)}`;
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupHookInWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;

      // Set up hooks for automatic metadata updates (PR URLs, branch names, etc.)
      await setupHookInWorkspace(session.workspacePath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAuggieAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;