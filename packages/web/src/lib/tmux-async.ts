import "server-only";

/**
 * Async tmux helpers for API routes.
 *
 * Uses a single `tmux list-sessions` call to check liveness of all sessions
 * at once, instead of N blocking `has-session` calls that starve the event loop.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Cached tmux path — resolved once per process. */
let cachedTmuxPath: string | undefined;

/** Find tmux binary (async, cached after first call). */
export async function findTmuxAsync(): Promise<string> {
  if (cachedTmuxPath) return cachedTmuxPath;

  const candidates = [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
  ];
  for (const p of candidates) {
    try {
      await execFileAsync(p, ["-V"], { timeout: 5000 });
      cachedTmuxPath = p;
      return p;
    } catch {
      continue;
    }
  }
  cachedTmuxPath = "tmux";
  return "tmux";
}

/**
 * Get the set of all live tmux session names (async, non-blocking).
 * One `tmux list-sessions` call replaces N `has-session` calls.
 */
export async function getAliveTmuxSessions(): Promise<Set<string>> {
  const tmuxPath = await findTmuxAsync();
  try {
    const { stdout } = await execFileAsync(tmuxPath, ["list-sessions", "-F", "#{session_name}"], {
      timeout: 5000,
    });
    return new Set(stdout.split("\n").filter(Boolean));
  } catch {
    // tmux not running or no sessions
    return new Set();
  }
}
