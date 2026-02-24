import {
  shellEscape,
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
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { writeFile, mkdir, readFile, readdir, rename, stat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

/** Shared bin directory for ao shell wrappers (prepended to PATH) */
const AO_BIN_DIR = join(homedir(), ".ao", "bin");

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "codex",
  slot: "agent" as const,
  description: "Agent plugin: OpenAI Codex CLI",
  version: "0.1.0",
};

// =============================================================================
// Shell Wrappers (automatic metadata updates — like Claude Code's PostToolUse)
// =============================================================================

/**
 * Helper script sourced by both gh and git wrappers.
 * Provides update_ao_metadata() for writing key=value to the session file.
 */
/* eslint-disable no-useless-escape -- \$ escapes are intentional: bash scripts in JS template literals */
const AO_METADATA_HELPER = `#!/usr/bin/env bash
# ao-metadata-helper — shared by gh/git wrappers
# Provides: update_ao_metadata <key> <value>

update_ao_metadata() {
  local key="\$1" value="\$2"
  local ao_dir="\${AO_DATA_DIR:-}"
  local ao_session="\${AO_SESSION:-}"

  [[ -z "\$ao_dir" || -z "\$ao_session" ]] && return 0

  # Validate: session name must not contain path separators or traversal
  case "\$ao_session" in
    */* | *..*) return 0 ;;
  esac

  # Validate: ao_dir must be an absolute path under known ao directories or /tmp
  case "\$ao_dir" in
    "\$HOME"/.ao/* | "\$HOME"/.agent-orchestrator/* | /tmp/*) ;;
    *) return 0 ;;
  esac

  local metadata_file="\$ao_dir/\$ao_session"

  # Resolve and verify the file is still within ao_dir
  local real_dir real_ao_dir
  real_ao_dir="\$(cd "\$ao_dir" 2>/dev/null && pwd -P)" || return 0
  real_dir="\$(cd "\$(dirname "\$metadata_file")" 2>/dev/null && pwd -P)" || return 0
  [[ "\$real_dir" == "\$real_ao_dir"* ]] || return 0

  [[ -f "\$metadata_file" ]] || return 0

  local temp_file="\${metadata_file}.tmp.\$\$"

  # Strip newlines from value to prevent metadata line injection
  local clean_value="\$(printf '%s' "\$value" | tr -d '\\n')"

  # Escape sed metacharacters in value (& expands to matched text, | breaks delimiter)
  local escaped_value="\$(printf '%s' "\$clean_value" | sed 's/[&|\\\\]/\\\\&/g')"

  if grep -q "^\${key}=" "\$metadata_file" 2>/dev/null; then
    sed "s|^\${key}=.*|\${key}=\${escaped_value}|" "\$metadata_file" > "\$temp_file"
  else
    cp "\$metadata_file" "\$temp_file"
    printf '%s=%s\\n' "\$key" "\$clean_value" >> "\$temp_file"
  fi

  mv "\$temp_file" "\$metadata_file"
}
`;

/**
 * gh wrapper — intercepts `gh pr create` and `gh pr merge` to auto-update
 * session metadata. All other commands pass through transparently.
 */
const GH_WRAPPER = `#!/usr/bin/env bash
# ao gh wrapper — auto-updates session metadata on PR operations

# Find real gh by removing our wrapper directory from PATH
ao_bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$ao_bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_gh="\$(PATH="\$clean_path" command -v gh 2>/dev/null)"

if [[ -z "\$real_gh" ]]; then
  echo "ao-wrapper: gh not found in PATH" >&2
  exit 127
fi

# Source the metadata helper
source "\$ao_bin_dir/ao-metadata-helper.sh" 2>/dev/null || true

# Only capture output for commands we need to parse (pr/create, pr/merge).
# All other commands pass through transparently without stream merging.
case "\$1/\$2" in
  pr/create|pr/merge)
    tmpout="\$(mktemp)"
    trap 'rm -f "\$tmpout"' EXIT

    "\$real_gh" "\$@" 2>&1 | tee "\$tmpout"
    exit_code=\${PIPESTATUS[0]}

    if [[ \$exit_code -eq 0 ]]; then
      output="\$(cat "\$tmpout")"
      case "\$1/\$2" in
        pr/create)
          pr_url="\$(echo "\$output" | grep -Eo 'https://github\\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)"
          if [[ -n "\$pr_url" ]]; then
            update_ao_metadata pr "\$pr_url"
            update_ao_metadata status pr_open
          fi
          ;;
        pr/merge)
          update_ao_metadata status merged
          ;;
      esac
    fi

    exit \$exit_code
    ;;
  *)
    exec "\$real_gh" "\$@"
    ;;
esac
`;

/**
 * git wrapper — intercepts branch creation commands to auto-update metadata.
 * All other commands pass through transparently.
 */
const GIT_WRAPPER = `#!/usr/bin/env bash
# ao git wrapper — auto-updates session metadata on branch operations

# Find real git by removing our wrapper directory from PATH
ao_bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$ao_bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_git="\$(PATH="\$clean_path" command -v git 2>/dev/null)"

if [[ -z "\$real_git" ]]; then
  echo "ao-wrapper: git not found in PATH" >&2
  exit 127
fi

# Source the metadata helper
source "\$ao_bin_dir/ao-metadata-helper.sh" 2>/dev/null || true

# Run real git
"\$real_git" "\$@"
exit_code=\$?

# Only update metadata on success
if [[ \$exit_code -eq 0 ]]; then
  case "\$1/\$2" in
    checkout/-b)
      update_ao_metadata branch "\$3"
      ;;
    switch/-c)
      update_ao_metadata branch "\$3"
      ;;
  esac
fi

exit \$exit_code
`;

// =============================================================================
// Workspace Setup
// =============================================================================

/**
 * Section appended to AGENTS.md as a secondary signal. The PATH-based wrappers
 * handle metadata updates automatically, but AGENTS.md reinforces the intent
 * and helps if the wrappers are bypassed.
 */
const AO_AGENTS_MD_SECTION = `
## Agent Orchestrator (ao) Session

You are running inside an Agent Orchestrator managed workspace.
Session metadata is updated automatically via shell wrappers.

If automatic updates fail, you can manually update metadata:
\`\`\`bash
~/.ao/bin/ao-metadata-helper.sh  # sourced automatically
# Then call: update_ao_metadata <key> <value>
\`\`\`
`;
/* eslint-enable no-useless-escape */

/**
 * Atomically write a file by writing to a temp file in the same directory,
 * then renaming. This prevents concurrent sessions from reading partially
 * written wrapper scripts.
 */
async function atomicWriteFile(filePath: string, content: string, mode: number): Promise<void> {
  const suffix = randomBytes(6).toString("hex");
  const tmpPath = `${filePath}.tmp.${suffix}`;
  await writeFile(tmpPath, content, { encoding: "utf-8", mode });
  await rename(tmpPath, filePath);
}

async function setupCodexWorkspace(workspacePath: string): Promise<void> {
  // 1. Write shared wrappers to ~/.ao/bin/
  await mkdir(AO_BIN_DIR, { recursive: true });

  await atomicWriteFile(
    join(AO_BIN_DIR, "ao-metadata-helper.sh"),
    AO_METADATA_HELPER,
    0o755,
  );

  // Only write wrappers if they don't exist or are outdated (check marker)
  const markerPath = join(AO_BIN_DIR, ".ao-version");
  const currentVersion = "0.1.0";
  let needsUpdate = true;
  try {
    const existing = await readFile(markerPath, "utf-8");
    if (existing.trim() === currentVersion) needsUpdate = false;
  } catch {
    // File doesn't exist — needs update
  }

  if (needsUpdate) {
    // Write wrappers atomically, then write the version marker last.
    // If we crash between wrapper writes and marker write, the next
    // invocation will redo the writes (safe: wrappers are idempotent).
    await atomicWriteFile(join(AO_BIN_DIR, "gh"), GH_WRAPPER, 0o755);
    await atomicWriteFile(join(AO_BIN_DIR, "git"), GIT_WRAPPER, 0o755);
    await atomicWriteFile(markerPath, currentVersion, 0o644);
  }

  // 2. Append ao section to AGENTS.md (create if missing, skip if already present)
  const agentsMdPath = join(workspacePath, "AGENTS.md");
  let existing = "";
  try {
    existing = await readFile(agentsMdPath, "utf-8");
  } catch {
    // File doesn't exist yet
  }

  if (!existing.includes("Agent Orchestrator (ao) Session")) {
    const content = existing
      ? existing.trimEnd() + "\n" + AO_AGENTS_MD_SECTION
      : AO_AGENTS_MD_SECTION.trimStart();
    await writeFile(agentsMdPath, content, "utf-8");
  }
}

// =============================================================================
// Codex Session JSONL Parsing (for getSessionInfo)
// =============================================================================

/** Codex session directory: ~/.codex/sessions/ */
const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

/** Typed representation of a line in a Codex JSONL session file */
interface CodexJsonlLine {
  type?: string;
  cwd?: string;
  model?: string;
  // Thread ID from thread_started notifications
  threadId?: string;
  // User message content (from user input events)
  content?: string;
  role?: string;
  // event_msg with token_count subtype
  msg?: {
    type?: string;
    input_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
  };
}

/**
 * Collect all JSONL files under a directory, recursively.
 * Codex stores sessions in date-sharded directories:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
async function collectJsonlFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry.endsWith(".jsonl")) {
      results.push(fullPath);
    } else {
      // Recurse into subdirectories (YYYY/MM/DD structure)
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          const nested = await collectJsonlFiles(fullPath);
          results.push(...nested);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }
  return results;
}

/**
 * Check if the first few lines of a JSONL file contain a session_meta
 * entry matching the given workspace path. Reads only the first 4 KB
 * to avoid loading large rollout files into memory.
 */
async function sessionFileMatchesCwd(
  filePath: string,
  workspacePath: string,
): Promise<boolean> {
  try {
    // Read only the first 4 KB — session_meta is always in the first few lines.
    // Avoids loading large rollout files (100 MB+) into memory.
    const handle = await open(filePath, "r");
    let content: string;
    try {
      const buffer = Buffer.allocUnsafe(4096);
      const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
      content = buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }
    const lines = content.split("\n").slice(0, 10);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          (parsed as CodexJsonlLine).type === "session_meta" &&
          (parsed as CodexJsonlLine).cwd === workspacePath
        ) {
          return true;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Unreadable file
  }
  return false;
}

/**
 * Find Codex session files whose `session_meta` cwd matches the given workspace path.
 * Recursively scans ~/.codex/sessions/ (date-sharded: YYYY/MM/DD/rollout-*.jsonl).
 * Returns the path to the most recently modified matching file, or null.
 */
async function findCodexSessionFile(workspacePath: string): Promise<string | null> {
  const jsonlFiles = await collectJsonlFiles(CODEX_SESSIONS_DIR);
  if (jsonlFiles.length === 0) return null;

  let bestMatch: { path: string; mtime: number } | null = null;

  for (const filePath of jsonlFiles) {
    const matches = await sessionFileMatchesCwd(filePath, workspacePath);
    if (matches) {
      try {
        const s = await stat(filePath);
        if (!bestMatch || s.mtimeMs > bestMatch.mtime) {
          bestMatch = { path: filePath, mtime: s.mtimeMs };
        }
      } catch {
        // Skip if stat fails
      }
    }
  }

  return bestMatch?.path ?? null;
}

/** Parse a Codex JSONL session file and extract all lines */
function parseCodexJsonl(content: string): CodexJsonlLine[] {
  const result: CodexJsonlLine[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        result.push(parsed as CodexJsonlLine);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return result;
}

/** Extract model name from Codex session_meta entry */
function extractCodexModel(lines: CodexJsonlLine[]): string | null {
  for (const line of lines) {
    if (line.type === "session_meta" && typeof line.model === "string") {
      return line.model;
    }
  }
  return null;
}

/** Aggregate token usage from Codex token_count events */
function extractCodexCost(lines: CodexJsonlLine[]): CostEstimate | undefined {
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of lines) {
    if (line.type === "event_msg" && line.msg?.type === "token_count") {
      inputTokens += line.msg.input_tokens ?? 0;
      inputTokens += line.msg.cached_tokens ?? 0;
      outputTokens += line.msg.output_tokens ?? 0;
      outputTokens += line.msg.reasoning_tokens ?? 0;
    }
  }

  if (inputTokens === 0 && outputTokens === 0) return undefined;

  // Rough cost estimate using GPT-4o pricing as baseline
  // ($2.50/1M input, $10/1M output)
  const estimatedCostUsd =
    (inputTokens / 1_000_000) * 2.5 + (outputTokens / 1_000_000) * 10.0;

  return { inputTokens, outputTokens, estimatedCostUsd };
}

/** Extract the Codex thread ID from JSONL (from thread_started or session_meta) */
function extractCodexThreadId(lines: CodexJsonlLine[]): string | null {
  for (const line of lines) {
    if (typeof line.threadId === "string" && line.threadId) {
      return line.threadId;
    }
  }
  return null;
}

// =============================================================================
// Binary Resolution
// =============================================================================

/**
 * Resolve the Codex CLI binary path.
 * Checks (in order): which, common fallback locations.
 * Returns "codex" as final fallback (let the shell resolve it at runtime).
 */
export async function resolveCodexBinary(): Promise<string> {
  // 1. Try `which codex`
  try {
    const { stdout } = await execFileAsync("which", ["codex"], { timeout: 10_000 });
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {
    // Not found via which
  }

  // 2. Check common locations (npm global, Homebrew, Cargo — Codex is now Rust-based)
  const home = homedir();
  const candidates = [
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    join(home, ".cargo", "bin", "codex"),
    join(home, ".npm", "bin", "codex"),
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
  return "codex";
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createCodexAgent(): Agent {
  /** Cached resolved binary path (populated by init or first getLaunchCommand) */
  let resolvedBinary: string | null = null;
  /** Guard against concurrent resolveCodexBinary() calls */
  let resolvingBinary: Promise<string> | null = null;

  return {
    name: "codex",
    processName: "codex",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const binary = resolvedBinary ?? "codex";
      const parts: string[] = [binary];

      // Approval policy mapping — cast to string for forward-compat with
      // extended permission values not yet in AgentLaunchConfig type.
      // Codex CLI uses --ask-for-approval (-a) with values:
      //   untrusted  — approve before any state-mutating command
      //   on-request — approve only for privilege escalation
      //   never      — no approval prompts (sandbox still applies)
      const perms = config.permissions as string | undefined;
      if (perms === "skip") {
        parts.push("--dangerously-bypass-approvals-and-sandbox");
      } else if (perms === "auto-edit") {
        parts.push("--ask-for-approval", "never");
      } else if (perms === "suggest") {
        parts.push("--ask-for-approval", "untrusted");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));

        // Auto-detect o-series models and enable reasoning via config override.
        // Codex does not have a --reasoning flag; reasoning is controlled via
        // the model_reasoning_effort config key.
        if (/^o[34]/i.test(config.model)) {
          parts.push("-c", "model_reasoning_effort=high");
        }
      }

      if (config.systemPromptFile) {
        // Codex reads developer instructions from a file via config override
        parts.push("-c", `model_instructions_file=${shellEscape(config.systemPromptFile)}`);
      } else if (config.systemPrompt) {
        // Codex accepts inline developer instructions via config override
        parts.push("-c", `developer_instructions=${shellEscape(config.systemPrompt)}`);
      }

      if (config.prompt) {
        // Use `--` to end option parsing so prompts starting with `-` aren't
        // misinterpreted as flags.
        parts.push("--", shellEscape(config.prompt));
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

      // Prepend ~/.ao/bin to PATH so our gh/git wrappers intercept commands.
      // The wrappers strip this directory from PATH before calling the real
      // binary, so there's no infinite recursion.
      env["PATH"] = `${AO_BIN_DIR}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      // If Codex is showing its input prompt, it's idle
      if (/^[>$#]\s*$/.test(lastLine)) return "idle";

      // Check last few lines for approval prompts
      const tail = lines.slice(-5).join("\n");
      if (/approval required/i.test(tail)) return "waiting_input";
      if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";

      // Default to active — specific patterns (esc to interrupt, spinner
      // symbols) all map to "active" so no need to check them individually.
      return "active";
    },

    async getActivityState(session: Session, _readyThresholdMs?: number): Promise<ActivityDetection | null> {
      // Check if process is running first
      if (!session.runtimeHandle) return { state: "exited" };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited" };

      // NOTE: Codex stores rollout files in a global ~/.codex/sessions/ directory
      // without workspace-specific scoping. When multiple Codex sessions run in
      // parallel, we cannot reliably determine which rollout file belongs to which
      // session. Until Codex provides per-workspace session tracking, we return
      // null (unknown) rather than guessing. See issue #13 for details.
      //
      // TODO: Implement proper per-session activity detection when Codex supports it.
      return null;
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
          const processRe = /(?:^|\/)codex(?:\s|$)/;
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

      const sessionFile = await findCodexSessionFile(session.workspacePath);
      if (!sessionFile) return null;

      let content: string;
      try {
        content = await readFile(sessionFile, "utf-8");
      } catch {
        return null;
      }

      const lines = parseCodexJsonl(content);
      if (lines.length === 0) return null;

      const agentSessionId = basename(sessionFile, ".jsonl");
      const model = extractCodexModel(lines);

      return {
        summary: model ? `Codex session (${model})` : null,
        summaryIsFallback: true,
        agentSessionId,
        cost: extractCodexCost(lines),
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      // Find the Codex session file for this workspace
      const sessionFile = await findCodexSessionFile(session.workspacePath);
      if (!sessionFile) return null;

      let content: string;
      try {
        content = await readFile(sessionFile, "utf-8");
      } catch {
        return null;
      }

      const lines = parseCodexJsonl(content);
      if (lines.length === 0) return null;

      // Extract the session/thread ID for native resume
      const threadId = extractCodexThreadId(lines);
      if (!threadId) return null;

      // Use Codex's native `resume` subcommand for proper conversation resume.
      // This restores the full thread state, not just a text prompt re-injection.
      const binary = resolvedBinary ?? "codex";
      const parts: string[] = [binary, "resume", shellEscape(threadId)];

      // Add approval policy flags from project config
      const perms = project.agentConfig?.permissions as string | undefined;
      if (perms === "skip") {
        parts.push("--dangerously-bypass-approvals-and-sandbox");
      } else if (perms === "auto-edit") {
        parts.push("--ask-for-approval", "never");
      } else if (perms === "suggest") {
        parts.push("--ask-for-approval", "untrusted");
      }

      const effectiveModel = project.agentConfig?.model ?? extractCodexModel(lines);
      if (effectiveModel) {
        parts.push("--model", shellEscape(effectiveModel as string));

        if (/^o[34]/i.test(effectiveModel as string)) {
          parts.push("-c", "model_reasoning_effort=high");
        }
      }

      return parts.join(" ");
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupCodexWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      // Resolve binary path on first launch (cached for subsequent calls).
      // Uses a promise guard to prevent concurrent calls from racing.
      if (!resolvedBinary) {
        if (!resolvingBinary) {
          resolvingBinary = resolveCodexBinary();
        }
        resolvedBinary = await resolvingBinary;
        resolvingBinary = null;
      }
      if (!session.workspacePath) return;
      await setupCodexWorkspace(session.workspacePath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCodexAgent();
}

export { CodexAppServerClient } from "./app-server-client.js";
export type {
  AppServerClientOptions,
  ThreadStartParams,
  TurnStartParams,
  NotificationHandler,
  ApprovalHandler,
  ApprovalDecision,
} from "./app-server-client.js";

export default { manifest, create } satisfies PluginModule<Agent>;
