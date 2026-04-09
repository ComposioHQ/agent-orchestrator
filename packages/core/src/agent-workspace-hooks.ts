/**
 * Shared PATH-based workspace hooks for agent plugins that don't have
 * native hook systems (Codex, Aider, OpenCode).
 *
 * Installs ~/.ao/bin/gh and ~/.ao/bin/git wrappers that intercept
 * PR creation, PR merge, and branch operations to auto-update session metadata.
 *
 * Claude Code uses its own PostToolUse hook system instead.
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
const WRAPPER_VERSION = "0.3.0";

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
 * Provides update_ao_metadata() for writing key=value to the session file.
 */
export const AO_METADATA_HELPER = `#!/usr/bin/env bash
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
`;

/**
 * gh wrapper — intercepts `gh pr create` and `gh pr merge` to auto-update
 * session metadata, and runs the churn guard before PR creation.
 * All other commands pass through transparently.
 */
export const GH_WRAPPER = `#!/usr/bin/env bash
# ao gh wrapper — churn guard + session metadata on PR operations

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

# Source the metadata helper
source "\$ao_bin_dir/ao-metadata-helper.sh" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Churn guard — warn when open PRs already touch same files (non-blocking).
# Fail-open: any error (no python3, no git, API timeout) allows the PR.
# Override: include "Supersedes #N" in --body to suppress the warning.
# ---------------------------------------------------------------------------
churn_guard() {
  command -v python3 &>/dev/null || return 0

  # Extract --body / -b value from the already-parsed arg list
  local body="" next_is_body=false
  for arg in "\$@"; do
    if \$next_is_body; then
      body="\$arg"
      next_is_body=false
      continue
    fi
    case "\$arg" in
      --body|-b) next_is_body=true ;;
      --body=*)  body="\${arg#--body=}" ;;
    esac
  done

  # Check for "Supersedes #N" override
  if printf '%s' "\$body" | python3 -c "
import sys, re
sys.exit(0 if re.search(r'supersedes\s*#\s*[0-9]+', sys.stdin.read(), re.IGNORECASE) else 1)
" 2>/dev/null; then
    return 0
  fi

  # Resolve repo from --repo / -R flag, then fall back to git remote
  local repo="" next_is_repo=false
  for arg in "\$@"; do
    if \$next_is_repo; then
      repo="\$arg"
      next_is_repo=false
      continue
    fi
    case "\$arg" in
      --repo|-R) next_is_repo=true ;;
      --repo=*)  repo="\${arg#--repo=}" ;;
    esac
  done
  if [[ -z "\$repo" ]]; then
    repo="\$(git remote get-url origin 2>/dev/null | python3 -c "
import sys, re
m = re.search(r'github\\.com[/:]([^/]+/[\\w.-]+?)(?:\\.git)?\$', sys.stdin.read().strip())
print(m.group(1) if m else '')
" 2>/dev/null)"
  fi
  [[ -z "\$repo" ]] && return 0

  # Files changed in this branch vs origin/main
  local changed_files
  changed_files="\$(git diff --name-only origin/main...HEAD 2>/dev/null)" || return 0
  [[ -z "\$changed_files" ]] && return 0

  # Check open PRs for file overlap (50s global deadline — fail open on timeout)
  local overlap
  overlap="\$(python3 - "\$repo" "\$changed_files" <<'PYEOF'
import sys, subprocess, json, time, re

repo = sys.argv[1]
my_files = set(sys.argv[2].strip().split('\\n'))
deadline = time.monotonic() + 50

try:
    br = subprocess.run(["git", "branch", "--show-current"],
                        capture_output=True, text=True, timeout=5)
    my_branch = br.stdout.strip() if br.returncode == 0 else ""

    rr = subprocess.run(["git", "remote", "get-url", "origin"],
                        capture_output=True, text=True, timeout=5)
    m = re.search(r'github\\.com[/:]([^/]+)/', rr.stdout.strip()) if rr.returncode == 0 else None
    my_owner = m.group(1) if m else ""

    timeout = max(5, int(deadline - time.monotonic() - 10))
    pr_list = subprocess.run(
        ["gh", "api", f"repos/{repo}/pulls", "--paginate",
         "--jq", "[.[] | {number:.number, title:.title, branch:.head.ref, owner:(.head.repo.owner.login // \"\")}]"],
        capture_output=True, text=True, timeout=timeout)
    if pr_list.returncode != 0:
        print("OK"); sys.exit(0)

    prs = []
    for line in pr_list.stdout.strip().split('\\n'):
        if line.strip():
            try: prs.extend(json.loads(line.strip()))
            except: pass

    overlapping = []
    for pr in prs:
        if pr.get("branch") == my_branch and (not my_owner or pr.get("owner") == my_owner):
            continue
        if time.monotonic() > deadline:
            break
        remaining = max(5, int(deadline - time.monotonic()))
        fr = subprocess.run(
            ["gh", "api", f"repos/{repo}/pulls/{pr['number']}/files",
             "--paginate", "--jq", ".[].filename"],
            capture_output=True, text=True, timeout=remaining)
        if fr.returncode != 0:
            continue
        common = my_files & set(f for f in fr.stdout.strip().split('\\n') if f)
        if common:
            files_str = ", ".join(list(common)[:3])
            if len(common) > 3: files_str += f" (+{len(common)-3} more)"
            overlapping.append(f"  PR #{pr['number']}: {pr['title']} — overlapping: {files_str}")

    if overlapping:
        print("OVERLAP")
        for line in overlapping:
            print(line)
    else:
        print("OK")
except Exception:
    print("OK")
PYEOF
  )" || return 0

  if printf '%s' "\$overlap" | grep -q "^OVERLAP"; then
    echo "" >&2
    echo "============================================" >&2
    echo "WARNING: File overlap with existing open PRs" >&2
    echo "" >&2
    echo "Your branch changes files already modified by open PRs:" >&2
    printf '%s\\n' "\$overlap" | tail -n +2 >&2
    echo "" >&2
    echo "  1. Check if the existing PR already covers your fix" >&2
    echo "  2. If yes: consider commenting on that PR instead" >&2
    echo "  3. If no: coordinate with the existing PR author" >&2
    echo "  4. Add 'Supersedes #<N>' to --body to suppress this warning." >&2
    echo "============================================" >&2
  fi

  return 0
}

# Only capture output for commands we need to parse (pr/create, pr/merge).
# All other commands pass through transparently without stream merging.
case "\$1/\$2" in
  pr/create)
    # Run churn guard before creating — warns on file overlap but does not block
    churn_guard "\$@"

    tmpout="\$(mktemp)"
    trap 'rm -f "\$tmpout"' EXIT

    "\$real_gh" "\$@" 2>&1 | tee "\$tmpout"
    exit_code=\${PIPESTATUS[0]}

    if [[ \$exit_code -eq 0 ]]; then
      output="\$(cat "\$tmpout")"
      pr_url="\$(echo "\$output" | grep -Eo 'https://github\\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)"
      if [[ -n "\$pr_url" ]]; then
        update_ao_metadata pr "\$pr_url"
        update_ao_metadata status pr_open
      fi
    fi

    exit \$exit_code
    ;;
  pr/merge)
    tmpout="\$(mktemp)"
    trap 'rm -f "\$tmpout"' EXIT

    "\$real_gh" "\$@" 2>&1 | tee "\$tmpout"
    exit_code=\${PIPESTATUS[0]}

    if [[ \$exit_code -eq 0 ]]; then
      update_ao_metadata status merged
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
    await atomicWriteFile(
      join(getAoBinDir(), "ao-metadata-helper.sh"),
      AO_METADATA_HELPER,
      0o755,
    );
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
