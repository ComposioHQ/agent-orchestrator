/**
 * checkpoint.ts
 *
 * Periodic git state snapshots for crash-safe session restore.
 *
 * writeCheckpoint()        — called by lifecycle-manager during polls for working sessions
 * buildCheckpointSummary() — called by session-manager.restore() after agent boots
 *
 * Design principle: checkpoints are best-effort and non-fatal.
 * A missing or corrupted checkpoint degrades gracefully — restore still works,
 * just without the ground-truth injection.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckpointData {
  /** Session this checkpoint belongs to */
  sessionId: string;
  /** ISO timestamp when this checkpoint was written */
  timestamp: string;
  /** HEAD commit hash at snapshot time */
  lastCommitHash: string;
  /** HEAD commit message at snapshot time */
  lastCommitMessage: string;
  /** Active branch name */
  branch: string;
  /** Files with staged changes (index != HEAD) */
  stagedFiles: string[];
  /** Files with unstaged changes (working tree != index) */
  modifiedFiles: string[];
  /** Untracked files */
  untrackedFiles: string[];
  /** True if staged or modified files exist */
  hasUncommittedChanges: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Returns the path to the checkpoint file for a session.
 * Stored in sessionsDir alongside session metadata — NOT inside the worktree,
 * so it survives worktree deletion and recreation.
 */
function getCheckpointPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.checkpoint`);
}

/**
 * Safely run a git command. Returns empty string on error instead of throwing.
 * All git calls are fire-and-forget safe — a failing git command should never
 * break the restore or poll flow.
 */
async function git(args: string[], cwd: string): Promise<string> {
  return execFileAsync("git", args, { cwd, timeout: 10_000 })
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
}

/**
 * Parse `git status --porcelain` output into categorized file lists.
 *
 * Porcelain format: XY filename
 *   X = status in staging area (index)
 *   Y = status in working tree
 *   ?? = untracked
 */
function parseGitStatus(raw: string): {
  stagedFiles: string[];
  modifiedFiles: string[];
  untrackedFiles: string[];
  hasUncommittedChanges: boolean;
} {
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of raw.split("\n").filter(Boolean)) {
    const x = line[0]; // index status
    const y = line[1]; // worktree status
    const file = line.slice(3).trim();

    if (x === "?" && y === "?") {
      untracked.push(file);
      continue;
    }
    if (x !== " " && x !== "?") {
      staged.push(file);
    }
    if (y !== " " && y !== "?") {
      modified.push(file);
    }
  }

  return {
    stagedFiles: staged,
    modifiedFiles: modified,
    untrackedFiles: untracked,
    hasUncommittedChanges: staged.length > 0 || modified.length > 0,
  };
}

/**
 * Capture the full git state of a workspace in parallel.
 */
async function captureGitState(
  workspacePath: string,
): Promise<Omit<CheckpointData, "sessionId" | "timestamp">> {
  const [logLine, branch, statusRaw] = await Promise.all([
    git(["log", "--oneline", "-1"], workspacePath),
    git(["branch", "--show-current"], workspacePath),
    git(["status", "--porcelain"], workspacePath),
  ]);

  // Parse "abc1234 commit message here" → hash + message
  const spaceIdx = logLine.indexOf(" ");
  const lastCommitHash = spaceIdx > -1 ? logLine.slice(0, spaceIdx) : logLine;
  const lastCommitMessage = spaceIdx > -1 ? logLine.slice(spaceIdx + 1) : "";

  return {
    lastCommitHash,
    lastCommitMessage,
    branch,
    ...parseGitStatus(statusRaw),
  };
}

/**
 * Atomic write: write to a .tmp file first, then rename into place.
 * Prevents a half-written checkpoint from being read on restore.
 * Falls back to a direct write if rename fails (e.g. cross-device).
 */
function safeWriteJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2);

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmp, json, "utf-8");
    renameSync(tmp, filePath); // atomic on POSIX — single syscall
  } catch {
    // Fallback: direct write (non-atomic but better than nothing)
    try {
      writeFileSync(filePath, json, "utf-8");
    } catch {
      // Silently swallow — checkpoints are best-effort, never crash the caller
    }
  }
}

/**
 * Read and parse a checkpoint file.
 * Returns null on any failure — missing file, corrupted JSON, wrong schema.
 */
function readCheckpoint(
  sessionsDir: string,
  sessionId: string,
): CheckpointData | null {
  const path = getCheckpointPath(sessionsDir, sessionId);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as CheckpointData;

    // Minimal schema check — if key fields are missing, treat as corrupted
    if (!parsed.sessionId || !parsed.timestamp || !parsed.lastCommitHash) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Snapshot the current git state for a working session.
 *
 * Called by lifecycle-manager.pollAll() for every session with status=working.
 * Skips silently if the workspace doesn't exist (agent still spawning, worktree deleted, etc).
 *
 * Never throws — all failures are swallowed. This must never break the poll loop.
 *
 * @param sessionId     - The AO session ID (e.g. "ao-5")
 * @param sessionsDir   - Path to the sessions metadata directory
 * @param workspacePath - Path to the session's git worktree
 */
export async function writeCheckpoint(
  sessionId: string,
  sessionsDir: string,
  workspacePath: string,
): Promise<void> {
  // Workspace might not exist yet (spawning) or may have been deleted
  if (!existsSync(workspacePath)) return;

  const gitState = await captureGitState(workspacePath);

  const checkpoint: CheckpointData = {
    sessionId,
    timestamp: new Date().toISOString(),
    ...gitState,
  };

  safeWriteJson(getCheckpointPath(sessionsDir, sessionId), checkpoint);
}

/**
 * Build a ground-truth summary message for injection after session restore.
 *
 * Called by session-manager.restore() after the agent boots.
 * Returns null if the workspace doesn't exist (nothing meaningful to inject).
 *
 * The returned string is markdown-formatted, ready to be sent directly to the
 * agent via plugins.runtime.sendMessage().
 *
 * @param sessionId     - The AO session ID
 * @param sessionsDir   - Path to the sessions metadata directory
 * @param workspacePath - Path to the session's git worktree
 */
export async function buildCheckpointSummary(
  sessionId: string,
  sessionsDir: string,
  workspacePath: string,
): Promise<string | null> {
  if (!existsSync(workspacePath)) return null;

  // Run all git queries in parallel — restore is already slow, don't serialize these
  const [log, statusRaw, diffStat] = await Promise.all([
    git(["log", "--oneline", "-3"], workspacePath),
    git(["status", "--porcelain"], workspacePath),
    git(["diff", "--stat"], workspacePath),
  ]);

  // Read the last periodic checkpoint if it exists
  const saved = readCheckpoint(sessionsDir, sessionId);

  const lines: string[] = [
    "## ⚠️ Session Restored After Crash",
    "",
    "You were restored after an unexpected exit.",
    "Before continuing, verify your understanding matches the actual workspace state below.",
    "",
    "### Current Git State (ground truth)",
    "```",
    "Last 3 commits:",
    log || "(no commits yet)",
    "",
    "Working tree:",
    statusRaw || "(clean — no uncommitted changes)",
    "",
    "Diff summary:",
    diffStat || "(no changes)",
    "```",
  ];

  // If a periodic checkpoint exists, include it so agent can spot discrepancies
  if (saved) {
    lines.push(
      "",
      "### Last Checkpoint (captured before crash)",
      `- **At:** ${saved.timestamp}`,
      `- **Commit:** \`${saved.lastCommitHash}\` ${saved.lastCommitMessage}`,
      `- **Branch:** ${saved.branch}`,
    );

    if (saved.stagedFiles.length > 0) {
      lines.push(`- **Staged:** ${saved.stagedFiles.join(", ")}`);
    }
    if (saved.modifiedFiles.length > 0) {
      lines.push(`- **Modified:** ${saved.modifiedFiles.join(", ")}`);
    }
    if (saved.untrackedFiles.length > 0) {
      lines.push(`- **Untracked:** ${saved.untrackedFiles.join(", ")}`);
    }
    if (saved.hasUncommittedChanges) {
      lines.push(
        "",
        "> ⚠️ You had uncommitted changes when you crashed.",
        "> They may still be on disk — check git status carefully.",
      );
    }
  } else {
    lines.push(
      "",
      "_No periodic checkpoint found — the git state above is the only ground truth available._",
    );
  }

  lines.push(
    "",
    "### Before You Continue",
    "1. Compare the git state above with your memory of what you were doing",
    "2. If any files look half-written, re-read them before editing",
    "3. Run `git status` and `git diff` yourself to confirm",
    "4. Resume from the **actual** state, not your assumed state",
  );

  return lines.join("\n");
}