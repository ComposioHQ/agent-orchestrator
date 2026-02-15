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

/** Get the metadata file path for a session. */
function metadataPath(dataDir: string, sessionId: SessionId): string {
  validateSessionId(sessionId);
  return join(dataDir, sessionId);
}

/**
 * Read metadata for a session. Returns null if the file doesn't exist.
 */
export function readMetadata(dataDir: string, sessionId: SessionId): SessionMetadata | null {
  const path = metadataPath(dataDir, sessionId);
  if (!existsSync(path)) return null;

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
    exploratory: raw["exploratory"],
  };
}

/**
 * Read raw metadata as a string record (for arbitrary keys).
 */
export function readMetadataRaw(
  dataDir: string,
  sessionId: SessionId,
): Record<string, string> | null {
  const path = metadataPath(dataDir, sessionId);
  if (!existsSync(path)) return null;
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
  if (metadata.exploratory) data["exploratory"] = metadata.exploratory;

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
  const path = metadataPath(dataDir, sessionId);
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
  const path = metadataPath(dataDir, sessionId);
  if (!existsSync(path)) return;

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
 */
export function listMetadata(dataDir: string): SessionId[] {
  const dir = dataDir;
  if (!existsSync(dir)) return [];

  return readdirSync(dir).filter((name) => {
    if (name === "archive" || name.startsWith(".")) return false;
    if (!VALID_SESSION_ID.test(name)) return false;
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
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
