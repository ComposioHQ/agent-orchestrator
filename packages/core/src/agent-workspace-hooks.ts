/**
 * Shared PATH-based workspace hooks for agent plugins that don't have
 * native hook systems (Codex, Aider, OpenCode).
 *
 * Installs ~/.ao/bin/gh and ~/.ao/bin/git wrappers that intercept
 * PR creation and branch operations to auto-update session metadata.
 *
 * Claude Code uses its own PostToolUse hook system instead.
 */
import { writeFile, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { isWindows } from "./platform.js";

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
const WRAPPER_VERSION = "0.5.0";

// =============================================================================
// PATH Builder
// =============================================================================

/**
 * Build a PATH string with ~/.ao/bin prepended for wrapper interception.
 * Deduplicates entries and ensures /usr/local/bin is early for gh resolution.
 */
export function buildAgentPath(basePath: string | undefined): string {
  const delimiter = isWindows() ? ";" : ":";
  const inherited = (basePath ?? (isWindows() ? "" : DEFAULT_PATH)).split(delimiter).filter(Boolean);
  const ordered: string[] = [];
  const seen = new Set<string>();

  const add = (entry: string): void => {
    if (!entry || seen.has(entry)) return;
    ordered.push(entry);
    seen.add(entry);
  };

  add(getAoBinDir());
  if (!isWindows()) {
    add(PREFERRED_GH_BIN_DIR);
  }

  for (const entry of inherited) add(entry);

  return ordered.join(delimiter);
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
 * gh wrapper — intercepts `gh pr create` to auto-update session metadata.
 * Merge/close state remains SCM-owned, so `gh pr merge` is not used to set
 * terminal session state directly.
 */
export const GH_WRAPPER = `#!/usr/bin/env bash
# ao gh wrapper — auto-updates session metadata on PR operations

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

# Only capture output for commands we need to parse (pr/create).
# All other commands pass through transparently without stream merging.
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

// =============================================================================
// Node.js Wrapper Scripts (Windows)
// =============================================================================

/**
 * Build a Node.js wrapper script for a given binary (gh or git).
 *
 * On Windows, bash scripts cannot be executed directly, so we generate:
 *  - <name>.cjs — the actual interception logic (Node.js, forced CJS mode)
 *  - <name>.cmd — a tiny CMD shim: @node "%~dp0<name>.cjs" %*
 *
 * The .js script replicates what the bash wrapper does:
 *  - gh:  intercepts `gh pr create` and `gh pr merge`
 *  - git: intercepts `git checkout -b` and `git switch -c`
 *
 * @param name           - "gh" or "git"
 * @param realBinaryPath - Absolute path to the real binary, or empty string to
 *                         resolve at runtime via PATH (excluding the wrapper dir).
 */
export function buildNodeWrapper(
  name: "gh" | "git",
  realBinaryPath: string,
): string {
  if (name === "gh") {
    return buildGhNodeWrapper(realBinaryPath);
  }
  return buildGitNodeWrapper(realBinaryPath);
}

/**
 * Shared Node.js snippet: updateAoMetadata function used by both gh and git wrappers.
 * Validates session, key, and AO_DATA_DIR before writing metadata.
 */
const NODE_UPDATE_AO_METADATA = `\
// ---------------------------------------------------------------------------
// Metadata update (shared by gh/git wrappers)
// ---------------------------------------------------------------------------
function updateAoMetadata(key, value) {
  const aoDir = process.env["AO_DATA_DIR"] || "";
  const aoSession = process.env["AO_SESSION"] || "";
  if (!aoDir || !aoSession) return;

  // Validate session — no path separators or traversal
  if (aoSession.includes("/") || aoSession.includes("\\\\") || aoSession.includes("..")) return;

  // Validate key
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) return;

  // Validate aoDir is under expected locations (mirrors bash ao-metadata-helper.sh)
  const os = require("os");
  const home = os.homedir();
  const sep = path.sep;
  let resolvedDir;
  try { resolvedDir = fs.realpathSync(aoDir); } catch { resolvedDir = path.resolve(aoDir); }
  const allowed = [path.join(home, ".ao"), path.join(home, ".agent-orchestrator"), os.tmpdir()];
  if (!allowed.some(a => resolvedDir === a || resolvedDir.startsWith(a + sep))) return;

  const metadataFile = path.join(resolvedDir, aoSession);
  if (!fs.existsSync(metadataFile)) return;

  // Strip newlines from value
  const cleanValue = String(value).replace(/[\\r\\n]/g, "");

  let content;
  try { content = fs.readFileSync(metadataFile, "utf8"); } catch { return; }

  const lines = content.split("\\n");
  const keyPrefix = key + "=";
  const idx = lines.findIndex(l => l.startsWith(keyPrefix));
  if (idx >= 0) {
    lines[idx] = key + "=" + cleanValue;
  } else {
    lines.push(key + "=" + cleanValue);
  }

  const tmpFile = metadataFile + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmpFile, lines.join("\\n"), "utf8");
    fs.renameSync(tmpFile, metadataFile);
  } catch {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}`;

function buildGhNodeWrapper(realBinaryPath: string): string {
  return `#!/usr/bin/env node
// ao gh wrapper (Windows Node.js) — auto-updates session metadata on PR operations
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Real binary resolution
// ---------------------------------------------------------------------------
const AO_BIN_DIR = path.dirname(__filename);

function findRealGh() {
  const explicit = process.env["GH_PATH"] || "";
  if (explicit) {
    try {
      const resolved = path.resolve(explicit);
      const dir = path.dirname(resolved);
      if (dir !== AO_BIN_DIR && fs.existsSync(resolved)) return resolved;
    } catch {}
  }

  // Walk PATH, skip wrapper directory
  const pathDirs = (process.env["PATH"] || "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir || path.resolve(dir) === AO_BIN_DIR) continue;
    // Windows executables always have an extension (.exe/.cmd). Skip the bare
    // no-extension case — on Windows X_OK is identical to F_OK (execute bit
    // doesn't exist), so a bare text file named "gh" would otherwise be
    // selected before gh.exe.
    for (const ext of [".exe", ".cmd"]) {
      const candidate = path.join(dir, "gh" + ext);
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

${NODE_UPDATE_AO_METADATA}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const realGh = ${realBinaryPath ? `(fs.existsSync(${JSON.stringify(realBinaryPath)}) ? ${JSON.stringify(realBinaryPath)} : findRealGh())` : "findRealGh()"};
if (!realGh) {
  process.stderr.write("ao-wrapper: gh not found in PATH\\n");
  process.exit(127);
}

const args = process.argv.slice(2);
const sub1 = args[0] || "";
const sub2 = args[1] || "";
const key = sub1 + "/" + sub2;

if (key === "pr/create" || key === "pr/merge") {
  const result = spawnSync(realGh, args, {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status === 0) {
    const output = (result.stdout || "") + (result.stderr || "");
    if (key === "pr/create") {
      const match = output.match(/https:\\/\\/github\\.com\\/[^/]+\\/[^/]+\\/pull\\/[0-9]+/);
      if (match) {
        updateAoMetadata("pr", match[0]);
        updateAoMetadata("status", "pr_open");
      }
    } else if (key === "pr/merge") {
      updateAoMetadata("status", "merged");
    }
  }

  process.exit(result.status ?? 1);
} else {
  const result = spawnSync(realGh, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`;
}

function buildGitNodeWrapper(realBinaryPath: string): string {
  return `#!/usr/bin/env node
// ao git wrapper (Windows Node.js) — auto-updates session metadata on branch operations
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Real binary resolution
// ---------------------------------------------------------------------------
const AO_BIN_DIR = path.dirname(__filename);

function findRealGit() {
  const pathDirs = (process.env["PATH"] || "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir || path.resolve(dir) === AO_BIN_DIR) continue;
    // Windows executables always have an extension (.exe/.cmd). Skip the bare
    // no-extension case — on Windows X_OK is identical to F_OK (execute bit
    // doesn't exist), so a bare text file named "git" would otherwise be
    // selected before git.exe.
    for (const ext of [".exe", ".cmd"]) {
      const candidate = path.join(dir, "git" + ext);
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

${NODE_UPDATE_AO_METADATA}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const realGit = ${realBinaryPath ? `(fs.existsSync(${JSON.stringify(realBinaryPath)}) ? ${JSON.stringify(realBinaryPath)} : findRealGit())` : "findRealGit()"};
if (!realGit) {
  process.stderr.write("ao-wrapper: git not found in PATH\\n");
  process.exit(127);
}

const args = process.argv.slice(2);
const result = spawnSync(realGit, args, { stdio: "inherit" });
const exitCode = result.status ?? 1;

if (exitCode === 0) {
  const sub1 = args[0] || "";
  const sub2 = args[1] || "";
  const key = sub1 + "/" + sub2;

  if (key === "checkout/-b" || key === "switch/-c") {
    const branch = args[2];
    if (branch) updateAoMetadata("branch", branch);
  } else if (sub1 === "checkout" || sub1 === "switch") {
    // Existing branch switch — only track feature-looking branches (contain / or -)
    let branch = sub2;
    // If sub2 is a flag, the actual branch name is in args[2]
    if (branch && branch.startsWith("-")) branch = args[2] || "";
    if (
      branch &&
      branch !== "HEAD" &&
      !branch.startsWith("-") &&
      (branch.includes("/") || branch.includes("-"))
    ) {
      updateAoMetadata("branch", branch);
    }
  }
}

process.exit(exitCode);
`;
}

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
    if (isWindows()) {
      // On Windows: generate Node.js .js wrappers + .cmd shims.
      // Bash scripts can't be executed directly on Windows.
      // Write wrappers atomically, then write the version marker last.
      for (const name of ["gh", "git"] as const) {
        const wrapperBase = join(getAoBinDir(), name);
        const nodeScript = buildNodeWrapper(name, "");
        // Use .cjs extension to force CJS mode regardless of any parent package.json "type" field
        await atomicWriteFile(wrapperBase + ".cjs", nodeScript, 0o644);
        // .cmd shim: delegates to node <wrapper>.cjs forwarding all args
        await atomicWriteFile(
          wrapperBase + ".cmd",
          `@node "%~dp0${name}.cjs" %*\r\n`,
          0o644,
        );
      }
    } else {
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
    }
    await atomicWriteFile(markerPath, WRAPPER_VERSION, 0o644);
  }

  // 2. Write AO session context to .ao/AGENTS.md (gitignored) so agents
  //    can discover they're in a managed session. We don't modify the
  //    repo-tracked AGENTS.md to avoid polluting worktrees with dirty state.
  const aoAgentsMdPath = join(workspacePath, ".ao", "AGENTS.md");
  await mkdir(join(workspacePath, ".ao"), { recursive: true });
  // On Windows, ao-metadata-helper.sh is never created — use a platform-appropriate section
  const agentsMdContent = isWindows()
    ? `## Agent Orchestrator (ao) Session\n\nYou are running inside an Agent Orchestrator managed workspace.\nSession metadata is updated automatically via shell wrappers.\n`
    : AO_AGENTS_MD_SECTION.trimStart();
  await writeFile(aoAgentsMdPath, agentsMdContent, "utf-8");
}
