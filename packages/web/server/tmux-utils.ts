/**
 * Shared tmux utilities for terminal servers.
 *
 * Extracted from direct-terminal-ws.ts and terminal-websocket.ts
 * so the logic can be properly unit tested.
 */

import { execFileSync } from "node:child_process";

/** Session ID validation regex — alphanumeric, hyphens, underscores only */
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a session ID format.
 * Prevents path traversal, shell injection, and other attacks.
 */
export function validateSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Find full path to tmux binary.
 *
 * Checks common installation locations because node-pty's posix_spawnp
 * doesn't reliably inherit PATH, and some Node.js environments (e.g.,
 * launched from GUI apps) have minimal PATH.
 *
 * @param execFn - Injectable execFileSync for testing. Defaults to child_process.execFileSync.
 */
export function findTmux(
  execFn: typeof execFileSync = execFileSync,
): string {
  const candidates = [
    "/opt/homebrew/bin/tmux", // macOS ARM (Homebrew)
    "/usr/local/bin/tmux", // macOS Intel (Homebrew)
    "/usr/bin/tmux", // Linux
  ];
  for (const p of candidates) {
    try {
      execFn(p, ["-V"], { timeout: 5000 });
      return p;
    } catch {
      continue;
    }
  }
  return "tmux"; // Fall back to bare name
}

/**
 * Resolve a user-facing session ID to its actual tmux session name.
 *
 * The hash-based architecture prefixes tmux session names with a config hash
 * (e.g., "8474d6f29887-ao-15" for user-facing "ao-15"). This function:
 *
 * 1. Tries exact match first using tmux's `=` prefix syntax to prevent
 *    prefix matching (where "ao-1" would incorrectly match "ao-15").
 * 2. Falls back to listing all sessions and finding one that ends with
 *    `-{sessionId}` (hash-prefixed match).
 *
 * @param sessionId - User-facing session ID (e.g., "ao-15")
 * @param tmuxPath - Full path to tmux binary
 * @param execFn - Injectable execFileSync for testing. Defaults to child_process.execFileSync.
 * @returns The actual tmux session name, or null if not found
 */
export function resolveTmuxSession(
  sessionId: string,
  tmuxPath: string,
  execFn: typeof execFileSync = execFileSync,
): string | null {
  // Try exact match first using = prefix for exact matching (e.g., "ao-orchestrator")
  // Without =, tmux uses prefix matching: "ao-1" would match "ao-15"
  try {
    execFn(tmuxPath, ["has-session", "-t", `=${sessionId}`], { timeout: 5000 });
    return sessionId;
  } catch {
    // Not an exact match
  }

  // Search for hash-prefixed tmux session (e.g., "8474d6f29887-ao-15" for "ao-15")
  try {
    const output = execFn(tmuxPath, ["list-sessions", "-F", "#{session_name}"], {
      timeout: 5000,
      encoding: "utf8",
    }) as string;
    const sessions = output.split("\n").filter(Boolean);
    const match = sessions.find((s) => s.endsWith(`-${sessionId}`));
    if (match) {
      return match;
    }
  } catch {
    // tmux not running or no sessions
  }

  return null;
}
