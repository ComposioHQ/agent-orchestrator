/**
 * Git Activity Polling — Tracks commits, file changes, and branch activity.
 *
 * Polls git log on each session's worktree to detect:
 * - New commits
 * - Files modified in recent commits
 * - Branch divergence from main
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DashboardSession } from "./types.js";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT = 10_000;

/** A single commit from git log */
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  timestamp: Date;
  files: string[];
}

/** Git activity for a single session */
export interface SessionGitActivity {
  sessionId: string;
  branch: string;
  commits: GitCommit[];
  /** How many commits ahead of main branch */
  commitsAhead: number;
  /** Files changed in recent commits */
  recentFiles: string[];
  lastPolledAt: Date;
}

/** A real-time activity event for the event stream */
export interface ActivityEvent {
  id: string;
  type: "commit" | "push" | "file_change" | "pr_opened" | "ci_status" | "review";
  sessionId: string;
  branch: string;
  message: string;
  timestamp: Date;
  data: {
    files?: string[];
    commitHash?: string;
    prNumber?: number;
    ciStatus?: string;
  };
}

/** Cached git activity by session ID */
const activityCache = new Map<string, SessionGitActivity>();

/** Track seen commit hashes to detect new commits */
const seenCommits = new Map<string, Set<string>>();

/** Event listeners for new activity */
type ActivityListener = (event: ActivityEvent) => void;
const listeners: ActivityListener[] = [];

/** Subscribe to activity events */
export function onActivity(listener: ActivityListener): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

/** Emit an activity event to all listeners */
function emitActivity(event: ActivityEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Ignore listener errors
    }
  }
}

/** Generate a unique event ID */
function generateEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Parse git log output into commits.
 * Format: hash|short|author|timestamp|subject
 */
function parseGitLog(output: string, files: Map<string, string[]>): GitCommit[] {
  const commits: GitCommit[] = [];
  const lines = output.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    const [hash, shortHash, author, timestamp, ...messageParts] = line.split("|");
    if (!hash) continue;

    commits.push({
      hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      author: author ?? "unknown",
      timestamp: new Date(timestamp ?? Date.now()),
      message: messageParts.join("|"),
      files: files.get(hash) ?? [],
    });
  }

  return commits;
}

/**
 * Get recent git activity for a session's worktree.
 * @param workspacePath - Path to the git worktree
 * @param branch - Branch name to check
 * @param defaultBranch - Main branch to compare against (e.g., "main")
 * @param sinceMinutes - How far back to look for commits
 */
export async function getGitActivity(
  workspacePath: string,
  branch: string,
  defaultBranch: string = "main",
  sinceMinutes: number = 30,
): Promise<{ commits: GitCommit[]; commitsAhead: number }> {
  try {
    // Get recent commits with custom format
    const logFormat = "%H|%h|%an|%aI|%s";
    const { stdout: logOutput } = await execFileAsync(
      "git",
      ["log", `--since=${sinceMinutes} minutes ago`, `--format=${logFormat}`, "-n", "50"],
      { cwd: workspacePath, timeout: EXEC_TIMEOUT },
    );

    // Get files changed per commit
    const files = new Map<string, string[]>();
    if (logOutput.trim()) {
      const hashes = logOutput
        .trim()
        .split("\n")
        .map((l) => l.split("|")[0])
        .filter(Boolean);

      for (const hash of hashes.slice(0, 10)) {
        // Only get files for most recent 10 commits
        try {
          const { stdout: filesOutput } = await execFileAsync(
            "git",
            ["diff-tree", "--no-commit-id", "--name-only", "-r", hash],
            { cwd: workspacePath, timeout: EXEC_TIMEOUT },
          );
          files.set(hash, filesOutput.trim().split("\n").filter(Boolean));
        } catch {
          // Skip if we can't get files
        }
      }
    }

    const commits = parseGitLog(logOutput, files);

    // Count commits ahead of default branch
    let commitsAhead = 0;
    try {
      const { stdout: aheadOutput } = await execFileAsync(
        "git",
        ["rev-list", "--count", `origin/${defaultBranch}..HEAD`],
        { cwd: workspacePath, timeout: EXEC_TIMEOUT },
      );
      commitsAhead = parseInt(aheadOutput.trim(), 10) || 0;
    } catch {
      // Branch comparison might fail if remote doesn't exist
    }

    return { commits, commitsAhead };
  } catch {
    // Git command failed — return empty
    return { commits: [], commitsAhead: 0 };
  }
}

/**
 * Poll git activity for multiple sessions.
 * Emits events for new commits detected.
 */
export async function pollSessionsActivity(
  sessions: DashboardSession[],
  defaultBranch: string = "main",
): Promise<Map<string, SessionGitActivity>> {
  const results = new Map<string, SessionGitActivity>();

  await Promise.all(
    sessions.map(async (session) => {
      if (!session.metadata?.["worktree"] || !session.branch) return;

      const workspacePath = session.metadata["worktree"];
      const { commits, commitsAhead } = await getGitActivity(
        workspacePath,
        session.branch,
        defaultBranch,
      );

      // Check for new commits and emit events
      const sessionSeen = seenCommits.get(session.id) ?? new Set();
      const recentFiles = new Set<string>();

      for (const commit of commits) {
        // Collect recent files
        for (const file of commit.files) {
          recentFiles.add(file);
        }

        // Emit event for new commits
        if (!sessionSeen.has(commit.hash)) {
          sessionSeen.add(commit.hash);
          emitActivity({
            id: generateEventId(),
            type: "commit",
            sessionId: session.id,
            branch: session.branch,
            message: `committed: "${commit.message}"`,
            timestamp: commit.timestamp,
            data: {
              files: commit.files,
              commitHash: commit.shortHash,
            },
          });

          // Also emit file change events for significant changes
          if (commit.files.length > 0) {
            emitActivity({
              id: generateEventId(),
              type: "file_change",
              sessionId: session.id,
              branch: session.branch,
              message: `modified ${commit.files.slice(0, 3).join(", ")}${commit.files.length > 3 ? ` +${commit.files.length - 3} more` : ""}`,
              timestamp: commit.timestamp,
              data: { files: commit.files },
            });
          }
        }
      }

      seenCommits.set(session.id, sessionSeen);

      const activity: SessionGitActivity = {
        sessionId: session.id,
        branch: session.branch,
        commits,
        commitsAhead,
        recentFiles: Array.from(recentFiles),
        lastPolledAt: new Date(),
      };

      results.set(session.id, activity);
      activityCache.set(session.id, activity);
    }),
  );

  return results;
}

/**
 * Get cached activity for a session.
 */
export function getCachedActivity(sessionId: string): SessionGitActivity | undefined {
  return activityCache.get(sessionId);
}

/**
 * Get all cached activity.
 */
export function getAllCachedActivity(): Map<string, SessionGitActivity> {
  return new Map(activityCache);
}

/**
 * Clear activity cache for a session.
 */
export function clearActivityCache(sessionId: string): void {
  activityCache.delete(sessionId);
  seenCommits.delete(sessionId);
}
