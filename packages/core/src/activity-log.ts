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
import { appendFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ActivityState, ActivityLogEntry } from "./types.js";
import { readLastJsonlEntry } from "./utils.js";

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

  const result = await readLastJsonlEntry(logPath);
  if (!result) return null;

  // readLastJsonlEntry gives us { lastType, modifiedAt }
  // We need the full parsed entry. Read the last line ourselves.
  try {
    const fileStat = await stat(logPath);
    // Read only the tail — activity logs are small (one entry per 30s poll)
    const { open } = await import("node:fs/promises");
    const handle = await open(logPath, "r");
    try {
      const { size } = fileStat;
      // Read last 1KB — more than enough for a single JSON line
      const tailSize = Math.min(size, 1024);
      const offset = Math.max(0, size - tailSize);
      const buffer = Buffer.allocUnsafe(tailSize);
      await handle.read(buffer, 0, tailSize, offset);
      const content = buffer.toString("utf-8");

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
