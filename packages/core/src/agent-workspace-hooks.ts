/**
 * Shared PATH-based workspace hooks for all agent plugins.
 *
 * Installs ~/.ao/bin/gh and ~/.ao/bin/git wrappers that:
 * - Intercept PR creation and branch operations to auto-update session metadata
 * - Cache repeated read-only gh commands (PR discovery, issue context) to reduce
 *   GitHub API traffic — see D4-wrapper-cache-plan.md for design
 *
 * The session manager injects these wrappers into every agent's PATH,
 * including Claude Code (which also has its own PostToolUse hooks for writes).
 */
import { writeFile, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_PATH = "/usr/bin:/bin";
const PREFERRED_GH_BIN_DIR = "/usr/local/bin";

/** Preferred gh binary path for wrapper scripts */
export const PREFERRED_GH_PATH = `${PREFERRED_GH_BIN_DIR}/gh`;

/**
 * Get the shared bin directory for ao shell wrappers (prepended to PATH).
 * Computed lazily to avoid calling homedir() at module load time,
 * which breaks test mocks that replace homedir after import.
 */
function getAoBinDir(): string {
  return join(homedir(), ".ao", "bin");
}

/** Current version of wrapper scripts — bump when scripts change */
const WRAPPER_VERSION = "0.4.0";

// =============================================================================
// PATH Builder
// =============================================================================

/**
 * Build a PATH string with ~/.ao/bin prepended for wrapper interception.
 * Deduplicates entries and ensures /usr/local/bin is early for gh resolution.
 */
export function buildAgentPath(basePath: string | undefined): string {
  const inherited = (basePath ?? DEFAULT_PATH).split(":").filter(Boolean);
  const ordered: string[] = [];
  const seen = new Set<string>();

  const add = (entry: string): void => {
    if (!entry || seen.has(entry)) return;
    ordered.push(entry);
    seen.add(entry);
  };

  add(getAoBinDir());
  add(PREFERRED_GH_BIN_DIR);

  for (const entry of inherited) add(entry);

  return ordered.join(":");
}

// =============================================================================
// Shell Wrapper Scripts
// =============================================================================

/* eslint-disable no-useless-escape -- \$ escapes are intentional: bash scripts in JS template literals */

/**
 * Helper script sourced by both gh and git wrappers.
 * Provides:
 *   update_ao_metadata <key> <value>   — write key=value to session metadata
 *   read_ao_metadata <key>             — read a value from session metadata
 *   ao_cache_dir                       — print the per-session gh cache directory
 *   ao_cache_fresh <key> <max_age>     — test if a cache entry is fresh (0 = infinite)
 *   ao_cache_read <key>                — print cached stdout
 *   ao_cache_write <key>               — write stdin to cache atomically
 */
export const AO_METADATA_HELPER = `#!/usr/bin/env bash
# ao-metadata-helper — shared by gh/git wrappers
# Provides: update_ao_metadata, read_ao_metadata, ao_cache_*

# ── Shared validation ────────────────────────────────────────────────────────

_ao_validate_env() {
  local ao_dir="\${AO_DATA_DIR:-}"
  local ao_session="\${AO_SESSION:-}"
  [[ -z "\$ao_dir" || -z "\$ao_session" ]] && return 1
  case "\$ao_session" in */* | *..*) return 1 ;; esac
  case "\$ao_dir" in
    "\$HOME"/.ao/* | "\$HOME"/.agent-orchestrator/* | /tmp/*) ;;
    *) return 1 ;;
  esac
  return 0
}

# ── Metadata write ───────────────────────────────────────────────────────────

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

  # Resolve symlinks and verify canonicalized paths are still within trusted roots
  local real_dir real_ao_dir
  real_ao_dir="\$(cd "\$ao_dir" 2>/dev/null && pwd -P)" || return 0
  real_dir="\$(cd "\$(dirname "\$metadata_file")" 2>/dev/null && pwd -P)" || return 0

  # Re-validate real_ao_dir against trusted roots after canonicalization
  # (prevents /tmp/../../home/user from escaping the allowlist)
  case "\$real_ao_dir" in
    "\$HOME"/.ao/* | "\$HOME"/.ao | "\$HOME"/.agent-orchestrator/* | "\$HOME"/.agent-orchestrator | /tmp/*) ;;
    *) return 0 ;;
  esac

  [[ "\$real_dir" == "\$real_ao_dir"* ]] || return 0

  [[ -f "\$metadata_file" ]] || return 0

  # Validate key — only allow alphanumeric, underscore, hyphen (prevents sed injection)
  [[ "\$key" =~ ^[a-zA-Z0-9_-]+$ ]] || return 0

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

# ── Metadata read ────────────────────────────────────────────────────────────

read_ao_metadata() {
  local key="\$1"
  _ao_validate_env || return 1
  local metadata_file="\${AO_DATA_DIR}/\${AO_SESSION}"
  [[ -f "\$metadata_file" ]] || return 1
  [[ "\$key" =~ ^[a-zA-Z0-9_-]+$ ]] || return 1
  local line
  line=\$(grep "^\${key}=" "\$metadata_file" 2>/dev/null | head -1) || return 1
  printf '%s' "\${line#*=}"
}

# ── Cache helpers ────────────────────────────────────────────────────────────

ao_cache_dir() {
  _ao_validate_env || return 1
  local d="\${AO_DATA_DIR}/.ghcache/\${AO_SESSION}"
  mkdir -p "\$d" 2>/dev/null || return 1
  printf '%s' "\$d"
}

ao_cache_fresh() {
  local cache_key="\$1" max_age="\$2"
  local cache_dir
  cache_dir="\$(ao_cache_dir)" || return 1
  local ts_file="\$cache_dir/\${cache_key}.ts"
  local stdout_file="\$cache_dir/\${cache_key}.stdout"
  [[ -f "\$stdout_file" && -f "\$ts_file" ]] || return 1
  # max_age=0 means infinite TTL
  [[ "\$max_age" -eq 0 ]] 2>/dev/null && return 0
  local cached_ts now
  cached_ts=\$(cat "\$ts_file" 2>/dev/null) || return 1
  now=\$(date +%s)
  (( now - cached_ts < max_age ))
}

ao_cache_read() {
  local cache_key="\$1"
  local cache_dir
  cache_dir="\$(ao_cache_dir)" || return 1
  cat "\$cache_dir/\${cache_key}.stdout"
}

ao_cache_write() {
  local cache_key="\$1"
  local cache_dir
  cache_dir="\$(ao_cache_dir)" || return 1
  local tmp="\$cache_dir/\${cache_key}.stdout.tmp.\$\$"
  cat > "\$tmp" && mv "\$tmp" "\$cache_dir/\${cache_key}.stdout"
  date +%s > "\$cache_dir/\${cache_key}.ts"
}
`;

/**
 * gh wrapper — intercepts agent-side gh calls for:
 * 1. Caching repeated read-only commands (PR discovery, issue context)
 * 2. Auto-updating session metadata on PR creation
 *
 * Cache storage: $AO_DATA_DIR/.ghcache/$AO_SESSION/{key}.stdout + {key}.ts
 * See D4-wrapper-cache-plan.md for full design rationale.
 */
export const GH_WRAPPER = `#!/usr/bin/env bash
# ao gh wrapper — caches reads + auto-updates metadata on writes

# Find real gh by removing our wrapper directory from PATH
ao_bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$ao_bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_gh=""

# Prefer explicit gh path when provided by AO environment.
# Guard against recursive self-reference to the wrapper in ~/.ao/bin.
if [[ -n "\${GH_PATH:-}" && -x "\$GH_PATH" ]]; then
  gh_dir="\$(cd "\$(dirname "\$GH_PATH")" 2>/dev/null && pwd)"
  if [[ "\$gh_dir" != "\$ao_bin_dir" ]]; then
    real_gh="\$GH_PATH"
  fi
fi

if [[ -z "\$real_gh" ]]; then
  real_gh="\$(PATH="\$clean_path" command -v gh 2>/dev/null)"
fi

if [[ -z "\$real_gh" ]]; then
  echo "ao-wrapper: gh not found in PATH" >&2
  exit 127
fi

# Source the metadata helper (provides update/read_ao_metadata, ao_cache_*)
source "\$ao_bin_dir/ao-metadata-helper.sh" 2>/dev/null || true

# Best-effort JSONL tracing for agent-side gh invocations.
log_gh_invocation() {
  local trace_file="\${AO_AGENT_GH_TRACE:-}"
  [[ -z "\$trace_file" ]] && return 0
  command -v jq >/dev/null 2>&1 || return 0

  mkdir -p "\$(dirname "\$trace_file")" 2>/dev/null || return 0

  local args_json
  args_json="\$(printf '%s\n' "\$@" | jq -Rsc 'split("\n")[:-1]')" || return 0

  jq -nc \
    --arg timestamp "\$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --arg cwd "\$PWD" \
    --arg aoSession "\${AO_SESSION:-}" \
    --arg aoSessionName "\${AO_SESSION_NAME:-}" \
    --arg aoProjectId "\${AO_PROJECT_ID:-}" \
    --arg aoIssueId "\${AO_ISSUE_ID:-}" \
    --arg aoCallerType "\${AO_CALLER_TYPE:-}" \
    --arg pid "\$\$" \
    --arg wrapperVersion "${WRAPPER_VERSION}" \
    --argjson args "\$args_json" \
    '{
      timestamp: $timestamp,
      cwd: $cwd,
      args: $args,
      aoSession: (if $aoSession == "" then null else $aoSession end),
      aoSessionName: (if $aoSessionName == "" then null else $aoSessionName end),
      aoProjectId: (if $aoProjectId == "" then null else $aoProjectId end),
      aoIssueId: (if $aoIssueId == "" then null else $aoIssueId end),
      aoCallerType: (if $aoCallerType == "" then null else $aoCallerType end),
      pid: ($pid | tonumber),
      wrapperVersion: $wrapperVersion
    }' >> "\$trace_file" 2>/dev/null || true
}

log_gh_invocation "\$@"

# =============================================================================
# Cacheable reads
# =============================================================================

# ── 1. PR discovery: gh pr list --head <B> --limit 1 ────────────────────────
# Infinite TTL for positive results (non-empty array). Never caches [].
if [[ "\$1" == "pr" && "\$2" == "list" ]]; then
  _ao_head="" _ao_limit="" _ao_cacheable=true
  _ao_saved_args=("\$@")
  shift 2
  while [[ \$# -gt 0 ]]; do
    case "\$1" in
      --head)     _ao_head="\$2"; shift 2 ;;
      --limit)    _ao_limit="\$2"; shift 2 ;;
      --repo|--json) shift 2 ;;  # consumed but not needed for cache key
      --search|--state|--assignee|--label|--jq|--template)
        _ao_cacheable=false; break ;;
      -*)         shift ;;  # skip unknown flags
      *)          shift ;;  # skip positional
    esac
  done
  set -- "\${_ao_saved_args[@]}"

  if [[ "\$_ao_cacheable" == true && "\$_ao_limit" == "1" && -n "\$_ao_head" ]]; then
    _ao_safe_branch=\$(printf '%s' "\$_ao_head" | tr -c 'a-zA-Z0-9._-' '-')
    _ao_cache_key="pr-discovery-\${_ao_safe_branch}"

    if ao_cache_fresh "\$_ao_cache_key" 0 2>/dev/null; then
      ao_cache_read "\$_ao_cache_key"
      exit 0
    fi

    # Cache miss — call real gh, cache positive results
    _ao_tmpout="\$(mktemp)"
    trap 'rm -f "\$_ao_tmpout"' EXIT
    "\$real_gh" "\$@" > "\$_ao_tmpout" 2>&1
    _ao_exit=\$?
    cat "\$_ao_tmpout"
    if [[ \$_ao_exit -eq 0 ]]; then
      _ao_out=\$(cat "\$_ao_tmpout")
      _ao_trimmed=\$(printf '%s' "\$_ao_out" | tr -d '[:space:]')
      # Only cache non-empty positive results
      if [[ -n "\$_ao_trimmed" && "\$_ao_trimmed" != "[]" ]]; then
        printf '%s' "\$_ao_out" | ao_cache_write "\$_ao_cache_key" 2>/dev/null || true
      fi
    fi
    exit \$_ao_exit
  fi
fi

# ── 2. Issue context: gh issue view <N> ─────────────────────────────────────
# 300-second TTL. Caches any successful response.
if [[ "\$1" == "issue" && "\$2" == "view" ]]; then
  _ao_issue_id="" _ao_cacheable=true
  _ao_saved_args=("\$@")
  shift 2
  # First non-flag arg is the issue identifier
  while [[ \$# -gt 0 ]]; do
    case "\$1" in
      --web|--comments|--jq|--template)
        _ao_cacheable=false; break ;;
      --repo|--json) shift 2 ;;
      -*)           shift ;;
      *)
        if [[ -z "\$_ao_issue_id" && "\$1" =~ ^[0-9]+$ ]]; then
          _ao_issue_id="\$1"
        fi
        shift ;;
    esac
  done
  set -- "\${_ao_saved_args[@]}"

  if [[ "\$_ao_cacheable" == true && -n "\$_ao_issue_id" ]]; then
    _ao_cache_key="issue-ctx-\${_ao_issue_id}"

    if ao_cache_fresh "\$_ao_cache_key" 300 2>/dev/null; then
      ao_cache_read "\$_ao_cache_key"
      exit 0
    fi

    _ao_tmpout="\$(mktemp)"
    trap 'rm -f "\$_ao_tmpout"' EXIT
    "\$real_gh" "\$@" > "\$_ao_tmpout" 2>&1
    _ao_exit=\$?
    cat "\$_ao_tmpout"
    if [[ \$_ao_exit -eq 0 ]]; then
      cat "\$_ao_tmpout" | ao_cache_write "\$_ao_cache_key" 2>/dev/null || true
    fi
    exit \$_ao_exit
  fi
fi

# =============================================================================
# Write intercepts
# =============================================================================

case "\$1/\$2" in
  pr/create)
    tmpout="\$(mktemp)"
    trap 'rm -f "\$tmpout"' EXIT

    "\$real_gh" "\$@" 2>&1 | tee "\$tmpout"
    exit_code=\${PIPESTATUS[0]}

    if [[ \$exit_code -eq 0 ]]; then
      output="\$(cat "\$tmpout")"
      pr_url="\$(echo "\$output" | grep -Eo 'https?://[^/]+/[^/]+/[^/]+/pull/[0-9]+' | head -1)"
      report_state="pr_created"
      report_draft="false"
      for arg in "\$@"; do
        if [[ "\$arg" == "--draft" || "\$arg" == "-d" ]]; then
          report_state="draft_pr_created"
          report_draft="true"
          break
        fi
      done
      if [[ -n "\$pr_url" ]]; then
        update_ao_metadata pr "\$pr_url"
        update_ao_metadata agentReportedPrUrl "\$pr_url"
      fi
      pr_number="\$(printf '%s' "\$pr_url" | grep -Eo '[0-9]+$' | head -1)"
      if [[ -n "\$pr_number" ]]; then
        update_ao_metadata agentReportedPrNumber "\$pr_number"
      fi
      update_ao_metadata agentReportedState "\$report_state"
      update_ao_metadata agentReportedAt "\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      update_ao_metadata agentReportedPrIsDraft "\$report_draft"

      # Populate PR discovery cache so subsequent gh pr list --head hits cache
      _branch="\$(read_ao_metadata branch 2>/dev/null)" || true
      if [[ -n "\$_branch" && -n "\$pr_url" && -n "\$pr_number" ]]; then
        _safe_branch=\$(printf '%s' "\$_branch" | tr -c 'a-zA-Z0-9._-' '-')
        _cache_key="pr-discovery-\${_safe_branch}"
        _cache_dir="\$(ao_cache_dir 2>/dev/null)" || true
        if [[ -n "\$_cache_dir" ]]; then
          _draft_val="\${report_draft:-false}"
          printf '[{"number":%s,"url":"%s","headRefName":"%s","isDraft":%s}]\\n' \
            "\$pr_number" "\$pr_url" "\$_branch" "\$_draft_val" \
            | ao_cache_write "\$_cache_key" 2>/dev/null || true
        fi
      fi
    fi

    exit \$exit_code
    ;;
  *)
    exec "\$real_gh" "\$@"
    ;;
esac
`;

/**
 * git wrapper — intercepts branch operations to auto-update metadata.
 * All other commands pass through transparently.
 *
 * Detects:
 * - git checkout -b <branch> / git switch -c <branch>  (new branch)
 * - git checkout <branch> / git switch <branch>         (existing feature branch)
 *
 * For existing branch switches, only updates if the branch name looks like a
 * feature branch (contains / or -) to avoid noise from checkout of commits/tags.
 * Matches the same heuristic as Claude Code's PostToolUse hook.
 */
export const GIT_WRAPPER = `#!/usr/bin/env bash
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
    checkout/*|switch/*)
      # Existing branch switch — only track feature-looking branches (contain / or -)
      # Skip flags (e.g. -B), HEAD, tags, commit hashes, and simple names like "main"
      branch="\$2"
      # If $2 is a flag, the actual branch name is in $3
      if [[ "\$branch" == -* ]]; then branch="\$3"; fi
      if [[ -n "\$branch" && "\$branch" != "HEAD" && "\$branch" != -* && "\$branch" == *[/-]* ]]; then
        update_ao_metadata branch "\$branch"
      fi
      ;;
  esac
fi

exit \$exit_code
`;

/**
 * Section appended to AGENTS.md as a secondary signal. The PATH-based wrappers
 * handle metadata updates automatically, but AGENTS.md reinforces the intent
 * and helps if the wrappers are bypassed.
 */
export const AO_AGENTS_MD_SECTION = `
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

// =============================================================================
// Workspace Setup
// =============================================================================

/**
 * Atomically write a file by writing to a temp file in the same directory,
 * then renaming. Prevents concurrent sessions from reading partially written scripts.
 */
async function atomicWriteFile(filePath: string, content: string, mode: number): Promise<void> {
  const suffix = randomBytes(6).toString("hex");
  const tmpPath = `${filePath}.tmp.${suffix}`;
  await writeFile(tmpPath, content, { encoding: "utf-8", mode });
  await rename(tmpPath, filePath);
}

/**
 * Install PATH-based shell wrappers and append an AO section to AGENTS.md.
 *
 * This is the standard workspace setup for agents that don't have native hook
 * systems (Codex, Aider, OpenCode). Call this from both `setupWorkspaceHooks`
 * and `postLaunchSetup`.
 *
 * 1. Creates ~/.ao/bin/ with gh/git wrappers and metadata helper script
 * 2. Appends an "Agent Orchestrator" section to the workspace AGENTS.md
 */
export async function setupPathWrapperWorkspace(workspacePath: string): Promise<void> {
  // 1. Write shared wrappers to ~/.ao/bin/ (skip if version marker matches)
  await mkdir(getAoBinDir(), { recursive: true });

  const markerPath = join(getAoBinDir(), ".ao-version");
  let needsUpdate = true;
  try {
    const existing = await readFile(markerPath, "utf-8");
    if (existing.trim() === WRAPPER_VERSION) needsUpdate = false;
  } catch {
    // File doesn't exist — needs update
  }

  if (needsUpdate) {
    await atomicWriteFile(join(getAoBinDir(), "ao-metadata-helper.sh"), AO_METADATA_HELPER, 0o755);
    // Write wrappers atomically, then write the version marker last.
    // If we crash between wrapper writes and marker write, the next
    // invocation will redo the writes (safe: wrappers are idempotent).
    await atomicWriteFile(join(getAoBinDir(), "gh"), GH_WRAPPER, 0o755);
    await atomicWriteFile(join(getAoBinDir(), "git"), GIT_WRAPPER, 0o755);
    await atomicWriteFile(markerPath, WRAPPER_VERSION, 0o644);
  }

  // 2. Write AO session context to .ao/AGENTS.md (gitignored) so agents
  //    can discover they're in a managed session. We don't modify the
  //    repo-tracked AGENTS.md to avoid polluting worktrees with dirty state.
  const aoAgentsMdPath = join(workspacePath, ".ao", "AGENTS.md");
  await mkdir(join(workspacePath, ".ao"), { recursive: true });
  await writeFile(aoAgentsMdPath, AO_AGENTS_MD_SECTION.trimStart(), "utf-8");
}
