import {
  shellEscape,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Metadata Updater — PATH-based wrapper scripts
// =============================================================================

/**
 * Directory name used for the git/gh wrapper scripts.
 * Created inside each workspace to intercept git/gh commands and update
 * session metadata automatically (branch, PR URL, status).
 */
const HOOKS_DIR = ".ao-hooks";

/**
 * Git wrapper script that intercepts git commands to update session metadata.
 * Detects checkout/switch commands and writes branch name to metadata.
 */
const GIT_WRAPPER_SCRIPT = `#!/usr/bin/env bash
# AO Git Wrapper — intercepts git commands to update session metadata
# Written by agent-codex plugin. Safe to delete; will be recreated.

# Find the real git by removing our directory from PATH
_ao_dir="$(cd "$(dirname "$0")" && pwd)"
_clean_path=""
IFS=: read -ra _parts <<< "$PATH"
for _p in "\${_parts[@]}"; do
  [ "$_p" = "$_ao_dir" ] && continue
  _clean_path="\${_clean_path:+$_clean_path:}$_p"
done
_real_git="$(PATH="$_clean_path" command -v git)" || { echo "ao-hooks: real git not found" >&2; exit 127; }

# Run the real git — stdout/stderr pass through normally
"$_real_git" "$@"
_ec=$?

# Skip metadata update on failure or missing env
[ "$_ec" -ne 0 ] && exit "$_ec"
[ -z "\${AO_SESSION:-}" ] || [ -z "\${AO_DATA_DIR:-}" ] && exit "$_ec"
_meta="$AO_DATA_DIR/$AO_SESSION"
[ -f "$_meta" ] || exit "$_ec"

_update_key() {
  local k="$1" v="$2" tmp="\${_meta}.tmp.$$"
  # Escape sed special characters in value (& | / \\)
  local ev=$(printf '%s' "$v" | sed 's/[&|\\/]/\\\\&/g')
  if grep -q "^$k=" "$_meta" 2>/dev/null; then
    sed "s|^$k=.*|$k=$ev|" "$_meta" > "$tmp"
  else
    cp "$_meta" "$tmp"
    printf '%s=%s\\n' "$k" "$v" >> "$tmp"
  fi
  mv "$tmp" "$_meta"
}

# Detect branch-changing commands from positional args
case "\${1:-}" in
  checkout)
    if [ "\${2:-}" = "-b" ] && [ -n "\${3:-}" ]; then
      _update_key "branch" "$3"
    elif [ -n "\${2:-}" ]; then
      case "\${2:-}" in
        -*) ;;
        */*|*-*) [ "\${2:-}" != "HEAD" ] && _update_key "branch" "$2" ;;
      esac
    fi
    ;;
  switch)
    if { [ "\${2:-}" = "-c" ] || [ "\${2:-}" = "--create" ]; } && [ -n "\${3:-}" ]; then
      _update_key "branch" "$3"
    elif [ -n "\${2:-}" ]; then
      case "\${2:-}" in
        -*) ;;
        */*|*-*) [ "\${2:-}" != "HEAD" ] && _update_key "branch" "$2" ;;
      esac
    fi
    ;;
esac

exit "$_ec"
`;

/**
 * GH CLI wrapper script that intercepts gh commands to update session metadata.
 * Detects pr create (extracts PR URL) and pr merge (sets status=merged).
 */
const GH_WRAPPER_SCRIPT = `#!/usr/bin/env bash
# AO GH Wrapper — intercepts gh commands to update session metadata
# Written by agent-codex plugin. Safe to delete; will be recreated.

# Find the real gh by removing our directory from PATH
_ao_dir="$(cd "$(dirname "$0")" && pwd)"
_clean_path=""
IFS=: read -ra _parts <<< "$PATH"
for _p in "\${_parts[@]}"; do
  [ "$_p" = "$_ao_dir" ] && continue
  _clean_path="\${_clean_path:+$_clean_path:}$_p"
done
_real_gh="$(PATH="$_clean_path" command -v gh)" || { echo "ao-hooks: real gh not found" >&2; exit 127; }

# Check metadata env early
_ao_ok=1
{ [ -z "\${AO_SESSION:-}" ] || [ -z "\${AO_DATA_DIR:-}" ]; } && _ao_ok=0
[ "$_ao_ok" = "1" ] && _meta="$AO_DATA_DIR/$AO_SESSION" || _meta=""
[ -n "$_meta" ] && [ ! -f "$_meta" ] && _ao_ok=0

_update_key() {
  local k="$1" v="$2" tmp="\${_meta}.tmp.$$"
  # Escape sed special characters in value (& | / \\)
  local ev=$(printf '%s' "$v" | sed 's/[&|\\/]/\\\\&/g')
  if grep -q "^$k=" "$_meta" 2>/dev/null; then
    sed "s|^$k=.*|$k=$ev|" "$_meta" > "$tmp"
  else
    cp "$_meta" "$tmp"
    printf '%s=%s\\n' "$k" "$v" >> "$tmp"
  fi
  mv "$tmp" "$_meta"
}

# For "gh pr create", capture stdout to extract PR URL
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "create" ]; then
  _out=$("$_real_gh" "$@") || _ec=$?
  _ec=\${_ec:-0}
  [ -n "$_out" ] && printf '%s\\n' "$_out"
  if [ "$_ec" -eq 0 ] && [ "$_ao_ok" = "1" ]; then
    _pr_url=$(printf '%s\\n' "$_out" | grep -Eo 'https://github[.]com/[^/]+/[^/]+/pull/[0-9]+' | head -1)
    if [ -n "$_pr_url" ]; then
      _update_key "pr" "$_pr_url"
      _update_key "status" "pr_open"
    fi
  fi
  exit "$_ec"
fi

# For "gh pr merge", run normally then update status
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "merge" ]; then
  "$_real_gh" "$@"
  _ec=$?
  [ "$_ec" -eq 0 ] && [ "$_ao_ok" = "1" ] && _update_key "status" "merged"
  exit "$_ec"
fi

# All other gh commands: pass through with zero overhead
exec "$_real_gh" "$@"
`;

// =============================================================================
// Hook Script Installer
// =============================================================================

/**
 * Write git/gh wrapper scripts to {basePath}/.ao-hooks/bin/.
 * Idempotent: overwrites existing scripts on each call.
 */
async function writeHookScripts(basePath: string): Promise<void> {
  const binDir = join(basePath, HOOKS_DIR, "bin");
  await mkdir(binDir, { recursive: true });

  const gitPath = join(binDir, "git");
  const ghPath = join(binDir, "gh");

  await writeFile(gitPath, GIT_WRAPPER_SCRIPT, "utf-8");
  await chmod(gitPath, 0o755);

  await writeFile(ghPath, GH_WRAPPER_SCRIPT, "utf-8");
  await chmod(ghPath, 0o755);
}

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
// Agent Implementation
// =============================================================================

function createCodexAgent(): Agent {
  return {
    name: "codex",
    processName: "codex",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["codex"];

      if (config.permissions === "skip") {
        parts.push("--approval-mode", "full-auto");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.systemPromptFile) {
        parts.push("--system-prompt", `"$(cat ${shellEscape(config.systemPromptFile)})"`);
      } else if (config.systemPrompt) {
        parts.push("--system-prompt", shellEscape(config.systemPrompt));
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

      // Prepend hooks bin directory to PATH so wrapper scripts intercept git/gh
      const hooksBin = join(config.projectConfig.path, HOOKS_DIR, "bin");
      const currentPath = process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
      env["PATH"] = `${hooksBin}:${currentPath}`;

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";
      // Codex doesn't have rich terminal output patterns yet
      return "active";
    },

    async getActivityState(session: Session, _readyThresholdMs?: number): Promise<ActivityDetection | null> {
      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

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

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      // Codex doesn't have JSONL session files for introspection yet
      return null;
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await writeHookScripts(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await writeHookScripts(session.workspacePath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCodexAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
