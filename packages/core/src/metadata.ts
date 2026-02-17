/**
 * Flat-file metadata read/write.
 *
 * Each session has a metadata file in the data directory, stored as
 * key=value pairs (one per line), matching the existing bash script format.
 *
 * Example file contents:
 *   worktree=/Users/foo/.worktrees/ao/ao-3
 *   branch=feat/INT-1234
 *   status=working
 *   pr=https://github.com/org/repo/pull/42
 *   issue=https://linear.app/team/issue/INT-1234
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  statSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { join, dirname } from "node:path";
import type { SessionId, SessionMetadata } from "./types.js";

/**
 * Parse a key=value metadata file into a record.
 * Lines starting with # are comments. Empty lines are skipped.
 * Only the first `=` is used as the delimiter (values can contain `=`).
 */
function parseMetadataFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/** Serialize a record back to key=value format. */
function serializeMetadata(data: Record<string, string>): string {
  return (
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  );
}

/** Validate sessionId to prevent path traversal. */
const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(sessionId: SessionId): void {
  if (!VALID_SESSION_ID.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

/** Get the canonical (flat) metadata file path for a session. Used for writes. */
function metadataPath(dataDir: string, sessionId: SessionId): string {
  validateSessionId(sessionId);
  return join(dataDir, sessionId);
}

/**
 * Find the actual metadata file for a session.
 *
 * Background: `ao spawn` (CLI) writes session metadata into project-scoped
 * subdirectories (`{dataDir}/{projectId}-sessions/{sessionId}`), while
 * `session-manager` (used by `ao start` / web API) writes flat files at
 * `{dataDir}/{sessionId}`. Both patterns are valid; this function checks both
 * so that reads always succeed regardless of which write path created the file.
 *
 * Returns the full path if found, or null if no file exists in either location.
 */
function resolveMetadataPath(dataDir: string, sessionId: SessionId): string | null {
  validateSessionId(sessionId);

  // Check flat path first (session-manager write path)
  const flat = join(dataDir, sessionId);
  try {
    if (existsSync(flat) && statSync(flat).isFile()) return flat;
  } catch {
    // fall through
  }

  // Check project subdirectories: {dataDir}/{anything}-sessions/{sessionId}
  // This is the ao-spawn CLI write path.
  if (!existsSync(dataDir)) return null;
  for (const entry of readdirSync(dataDir)) {
    if (!entry.endsWith("-sessions")) continue;
    const candidate = join(dataDir, entry, sessionId);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Read metadata for a session. Returns null if the file doesn't exist.
 */
export function readMetadata(dataDir: string, sessionId: SessionId): SessionMetadata | null {
  const path = resolveMetadataPath(dataDir, sessionId);
  if (!path) return null;

  const content = readFileSync(path, "utf-8");
  const raw = parseMetadataFile(content);

  return {
    worktree: raw["worktree"] ?? "",
    branch: raw["branch"] ?? "",
    status: raw["status"] ?? "unknown",
    issue: raw["issue"],
    pr: raw["pr"],
    summary: raw["summary"],
    project: raw["project"],
    createdAt: raw["createdAt"],
    runtimeHandle: raw["runtimeHandle"],
  };
}

/**
 * Read raw metadata as a string record (for arbitrary keys).
 */
export function readMetadataRaw(
  dataDir: string,
  sessionId: SessionId,
): Record<string, string> | null {
  const path = resolveMetadataPath(dataDir, sessionId);
  if (!path) return null;
  return parseMetadataFile(readFileSync(path, "utf-8"));
}

/**
 * Write full metadata for a session (overwrites existing file).
 */
export function writeMetadata(
  dataDir: string,
  sessionId: SessionId,
  metadata: SessionMetadata,
): void {
  const path = metadataPath(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });

  const data: Record<string, string> = {
    worktree: metadata.worktree,
    branch: metadata.branch,
    status: metadata.status,
  };

  if (metadata.issue) data["issue"] = metadata.issue;
  if (metadata.pr) data["pr"] = metadata.pr;
  if (metadata.summary) data["summary"] = metadata.summary;
  if (metadata.project) data["project"] = metadata.project;
  if (metadata.createdAt) data["createdAt"] = metadata.createdAt;
  if (metadata.runtimeHandle) data["runtimeHandle"] = metadata.runtimeHandle;

  writeFileSync(path, serializeMetadata(data), "utf-8");
}

/**
 * Update specific fields in a session's metadata.
 * Reads existing file, merges updates, writes back.
 */
export function updateMetadata(
  dataDir: string,
  sessionId: SessionId,
  updates: Partial<Record<string, string>>,
): void {
  // Use the existing file location if found; fall back to flat path for new files.
  const path = resolveMetadataPath(dataDir, sessionId) ?? metadataPath(dataDir, sessionId);
  let existing: Record<string, string> = {};

  if (existsSync(path)) {
    existing = parseMetadataFile(readFileSync(path, "utf-8"));
  }

  // Merge updates — remove keys set to empty string
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === "") {
      const { [key]: _, ...rest } = existing;
      existing = rest;
    } else {
      existing[key] = value;
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeMetadata(existing), "utf-8");
}

/**
 * Delete a session's metadata file.
 * Optionally archive it to an `archive/` subdirectory.
 */
export function deleteMetadata(dataDir: string, sessionId: SessionId, archive = true): void {
  const path = resolveMetadataPath(dataDir, sessionId);
  if (!path) return;

  if (archive) {
    const archiveDir = join(dataDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(archiveDir, `${sessionId}_${timestamp}`);
    writeFileSync(archivePath, readFileSync(path, "utf-8"));
  }

  unlinkSync(path);
}

/**
 * List all session IDs that have metadata files.
 *
 * Scans two locations:
 * 1. Flat files at `{dataDir}/{sessionId}` — written by session-manager (ao start)
 * 2. Project subdirectories `{dataDir}/{projectId}-sessions/{sessionId}` — written
 *    by the `ao spawn` CLI command
 *
 * Both patterns coexist; this function deduplicates by session ID.
 */
export function listMetadata(dataDir: string): SessionId[] {
  if (!existsSync(dataDir)) return [];

  const seen = new Set<string>();

  for (const name of readdirSync(dataDir)) {
    if (name === "archive" || name.startsWith(".")) continue;

    const fullPath = join(dataDir, name);
    try {
      const stat = statSync(fullPath);

      if (stat.isFile() && VALID_SESSION_ID.test(name)) {
        // Flat session file (session-manager write path)
        seen.add(name);
      } else if (stat.isDirectory() && name.endsWith("-sessions")) {
        // Project subdirectory (ao spawn CLI write path)
        for (const entry of readdirSync(fullPath)) {
          if (entry === "archive" || entry.startsWith(".")) continue;
          if (!VALID_SESSION_ID.test(entry)) continue;
          try {
            if (statSync(join(fullPath, entry)).isFile()) seen.add(entry);
          } catch {
            // skip unreadable entries
          }
        }
      }
    } catch {
      // skip entries that error on stat
    }
  }

  return [...seen] as SessionId[];
}

/**
 * Atomically reserve a session ID by creating its metadata file with O_EXCL.
 * Returns true if the ID was successfully reserved, false if it already exists.
 */
export function reserveSessionId(dataDir: string, sessionId: SessionId): boolean {
  const path = metadataPath(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}
