import {
  shellEscape,
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
import { writeFile, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Shared bin directory for ao shell wrappers (prepended to PATH) */
const AO_BIN_DIR = join(homedir(), ".ao", "bin");

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "gemini",
  slot: "agent" as const,
  description: "Agent plugin: Gemini CLI",
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

async function setupGeminiWorkspace(workspacePath: string): Promise<void> {
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
    await atomicWriteFile(join(AO_BIN_DIR, "gh"), GH_WRAPPER, 0o755);
    await atomicWriteFile(join(AO_BIN_DIR, "git"), GIT_WRAPPER, 0o755);
    await atomicWriteFile(markerPath, currentVersion, 0o644);
  }

  // 2. Append ao section to AGENTS.md (create if missing, skip if already present)
  // NOTE: GEMINI.md (system prompt) is written at launch time via getLaunchCommand's
  // compound shell prefix (cp/printf), not here, because the system prompt content
  // is only available from AgentLaunchConfig, not at workspace setup time.
  const agentsMdPath = join(workspacePath, "AGENTS.md");
  let existingAgentsMd = "";
  try {
    existingAgentsMd = await readFile(agentsMdPath, "utf-8");
  } catch {
    // File doesn't exist yet
  }

  if (!existingAgentsMd.includes("Agent Orchestrator (ao) Session")) {
    const content = existingAgentsMd
      ? existingAgentsMd.trimEnd() + "\n" + AO_AGENTS_MD_SECTION
      : AO_AGENTS_MD_SECTION.trimStart();
    await writeFile(agentsMdPath, content, "utf-8");
  }
}

// =============================================================================
// Gemini Session Detection
// =============================================================================

/** Gemini session directory: ~/.gemini/tmp/ */
const GEMINI_TMP_DIR = join(homedir(), ".gemini", "tmp");

/**
 * Check if any Gemini session data exists under ~/.gemini/tmp/.
 * Used by getRestoreCommand to guard against `gemini -r latest` when no
 * prior session exists.
 */
async function hasGeminiSessions(): Promise<boolean> {
  try {
    const dirs = await readdir(GEMINI_TMP_DIR);
    return dirs.length > 0;
  } catch {
    return false;
  }
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createGeminiAgent(): Agent {
  return {
    name: "gemini",
    processName: "gemini",

    getLaunchCommand(config: AgentLaunchConfig): string {
      // Gemini CLI auto-reads GEMINI.md from workspace root as its system prompt.
      // Since there's no --system-prompt CLI flag, we write the file before launching
      // via a compound shell command. The tmux session is cd'd into the workspace,
      // so relative paths work. systemPromptFile is preferred (avoids shell truncation
      // for long prompts); inline systemPrompt is a fallback.
      let prefix = "";
      if (config.systemPromptFile) {
        prefix = `cp ${shellEscape(config.systemPromptFile)} GEMINI.md && `;
      } else if (config.systemPrompt) {
        prefix = `printf '%s' ${shellEscape(config.systemPrompt)} > GEMINI.md && `;
      }

      const parts: string[] = ["gemini"];

      // --yolo auto-approves all actions (equivalent to "skip" permissions)
      if (config.permissions === "skip") {
        parts.push("--yolo");
      }

      if (config.model) {
        parts.push("-m", shellEscape(config.model));
      }

      if (config.prompt) {
        // -p <prompt> for headless mode
        parts.push("-p", shellEscape(config.prompt));
      }

      return prefix + parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // Prepend ~/.ao/bin to PATH so our gh/git wrappers intercept commands.
      env["PATH"] = `${AO_BIN_DIR}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      // If Gemini is showing its input prompt, it's idle
      if (/^[>$#]\s*$/.test(lastLine)) return "idle";

      // Check last few lines for approval prompts
      const tail = lines.slice(-5).join("\n");
      if (/approve|confirm/i.test(tail)) return "waiting_input";
      if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";

      return "active";
    },

    async getActivityState(session: Session, _readyThresholdMs?: number): Promise<ActivityDetection | null> {
      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      // NOTE: Gemini stores sessions under ~/.gemini/tmp/{project-id}/chats/ but
      // there is no documented mapping from workspace path to project-id. Scanning
      // all projects and picking the globally newest file (as before) would attribute
      // one session's activity to another when multiple Gemini sessions run in
      // parallel. Until Gemini provides per-workspace session scoping, we return
      // null (unknown) rather than returning potentially incorrect data.
      //
      // TODO: Implement proper per-session activity detection when Gemini exposes
      //       a workspace-to-project-id mapping.
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
          const processRe = /(?:^|\/)gemini(?:\s|$)/;
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

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      // Cannot reliably scope session files to a specific workspace — see
      // getActivityState comment. Return null to avoid cross-session data leaks.
      return null;
    },

    async getRestoreCommand(_session: Session, project: ProjectConfig): Promise<string | null> {
      // Check if any Gemini session exists before returning a restore command.
      // Without this guard, `gemini -r latest` would fail when no prior session
      // exists, and the caller couldn't fall back to getLaunchCommand.
      const hasSession = await hasGeminiSessions();
      if (!hasSession) return null;

      // Gemini CLI supports -r latest to resume the most recent session
      const parts: string[] = ["gemini"];

      if ((project.agentConfig?.permissions as string | undefined) === "skip") {
        parts.push("--yolo");
      }

      const model = project.agentConfig?.model as string | undefined;
      if (model) {
        parts.push("-m", shellEscape(model));
      }

      parts.push("-r", "latest");

      return parts.join(" ");
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupGeminiWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await setupGeminiWorkspace(session.workspacePath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createGeminiAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
