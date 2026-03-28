/**
 * Activity JSONL log — shared utilities for agents that don't have native JSONL.
 *
 * Agents like Aider and OpenCode use this to write activity observations
 * (derived from terminal output) to `{workspacePath}/.ao/activity.jsonl`.
 * Their `getActivityState()` then reads from this file, enabling detection
 * of states like `waiting_input` and `blocked` that terminal-only parsing
 * couldn't surface through the deprecated `detectActivity()` path.
 *
 * Agents with native JSONL (Claude Code, Codex) don't use this — they read
 * richer data directly from their own session files.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ActivityState, ActivityLogEntry, ActivityDetection } from "./types.js";

/**
 * Maximum age (ms) for `waiting_input`/`blocked` entries before they're
 * considered stale. If no new terminal output overwrites the entry within
 * this window, the state falls through to downstream fallbacks instead of
 * keeping the session stuck in `needs_input` on the dashboard forever.
 */
export const ACTIVITY_INPUT_STALENESS_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get the path to the activity JSONL log for a session.
 * Location: `{workspacePath}/.ao/activity.jsonl`
 */
export function getActivityLogPath(workspacePath: string): string {
  return join(workspacePath, ".ao", "activity.jsonl");
}

/**
 * Append an activity observation to the session's JSONL log.
 * Creates the `.ao/` directory if it doesn't exist.
 */
export async function appendActivityEntry(
  workspacePath: string,
  state: ActivityState,
  source: "terminal" | "native",
  trigger?: string,
): Promise<void> {
  const logPath = getActivityLogPath(workspacePath);
  await mkdir(dirname(logPath), { recursive: true });

  const entry: ActivityLogEntry = {
    ts: new Date().toISOString(),
    state,
    source,
    ...(trigger !== undefined &&
      (state === "waiting_input" || state === "blocked") && { trigger }),
  };

  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Read the last activity entry from the session's JSONL log.
 * Returns the parsed entry with the file's modification time, or null if
 * the file doesn't exist or is empty.
 */
export async function readLastActivityEntry(
  workspacePath: string,
): Promise<{ entry: ActivityLogEntry; modifiedAt: Date } | null> {
  const logPath = getActivityLogPath(workspacePath);

  try {
    const { open } = await import("node:fs/promises");
    const handle = await open(logPath, "r");
    try {
      const fileStat = await handle.stat();
      if (fileStat.size === 0) return null;

      // Read last 1KB — more than enough for a single JSON line
      const tailSize = Math.min(fileStat.size, 1024);
      const offset = Math.max(0, fileStat.size - tailSize);
      const buffer = Buffer.alloc(tailSize);
      const { bytesRead } = await handle.read(buffer, 0, tailSize, offset);
      if (bytesRead === 0) return null;
      const content = buffer.subarray(0, bytesRead).toString("utf-8");

      // Find the last non-empty line
      const lines = content.split("\n").filter((l) => l.trim());
      if (lines.length === 0) return null;

      const lastLine = lines[lines.length - 1];
      if (!lastLine) return null;
      const parsed: unknown = JSON.parse(lastLine);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

      const entry = parsed as ActivityLogEntry;
      return { entry, modifiedAt: fileStat.mtime };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Check the AO activity JSONL for the current state.
 *
 * Returns an `ActivityDetection` for `waiting_input`/`blocked` (with a staleness
 * cap), fresh non-critical states within `thresholdMs`, or `null` if nothing
 * useful was found. Callers should fall through to their own fallback signals
 * when this returns `null`.
 */
export function checkActivityLogState(
  activityResult: { entry: ActivityLogEntry; modifiedAt: Date } | null,
  thresholdMs: number,
): ActivityDetection | null {
  if (!activityResult) return null;

  const { entry, modifiedAt } = activityResult;
  const ageMs = Date.now() - modifiedAt.getTime();

  if (entry.state === "waiting_input" || entry.state === "blocked") {
    if (ageMs <= ACTIVITY_INPUT_STALENESS_MS) {
      return { state: entry.state, timestamp: modifiedAt };
    }
    // Stale — fall through so callers use other signals
    return null;
  }

  if (ageMs <= thresholdMs) {
    return { state: entry.state, timestamp: modifiedAt };
  }

  return null;
}

/**
 * Build the arguments for `appendActivityEntry` from terminal output.
 *
 * Classifies terminal output via the provided `detectActivity` function and
 * returns the state + trigger. Plugins call `appendActivityEntry` themselves
 * (keeping it mockable in tests).
 */
export function classifyTerminalActivity(
  terminalOutput: string,
  detectActivity: (output: string) => ActivityState,
): { state: ActivityState; trigger: string | undefined } {
  const state = detectActivity(terminalOutput);
  const trigger =
    state === "waiting_input" || state === "blocked"
      ? terminalOutput.trim().split("\n").slice(-3).join("\n")
      : undefined;
  return { state, trigger };
}
