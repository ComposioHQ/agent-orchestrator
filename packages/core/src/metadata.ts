/**
 * Flat-file metadata read/write.
 *
 * Architecture:
 * - Session metadata stored in project-specific directories
 * - Path: ~/.agent-orchestrator/{hash}-{projectId}/sessions/{sessionName}
 * - Session files use user-facing names (int-1) not tmux names (a3b4c5d6e7f8-int-1)
 * - Metadata includes tmuxName field to map user-facing → tmux name
 *
 * Format: key=value pairs (one per line), compatible with bash scripts
 *
 * Example file contents:
 *   project=integrator
 *   worktree=/Users/foo/.agent-orchestrator/a3b4c5d6e7f8-integrator/worktrees/int-1
 *   branch=feat/INT-1234
 *   status=working
 *   tmuxName=a3b4c5d6e7f8-int-1
 *   pr=https://github.com/org/repo/pull/42
 *   issue=INT-1234
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
import type { CanonicalSessionLifecycle, SessionId, SessionMetadata, SessionStatus } from "./types.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { parseKeyValueContent } from "./key-value.js";
import {
  buildLifecycleMetadataPatch,
  cloneLifecycle,
  parseCanonicalLifecycle,
} from "./lifecycle-state.js";
import { assertValidSessionIdComponent, SESSION_ID_COMPONENT_PATTERN } from "./utils/session-id.js";
import { validateStatus } from "./utils/validation.js";

/** Serialize a record back to key=value format. Newlines in values are replaced to prevent injection. */
function serializeMetadata(data: Record<string, string>): string {
  return (
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v.replace(/[\r\n]/g, " ")}`)
      .join("\n") + "\n"
  );
}

function validateSessionId(sessionId: SessionId): void {
  assertValidSessionIdComponent(sessionId);
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
  const raw = parseKeyValueContent(content);

  return {
    worktree: raw["worktree"] ?? "",
    branch: raw["branch"] ?? "",
    status: raw["status"] ?? "unknown",
    tmuxName: raw["tmuxName"],
    issue: raw["issue"],
    pr: raw["pr"],
    prAutoDetect:
      raw["prAutoDetect"] === "off" ? "off" : raw["prAutoDetect"] === "on" ? "on" : undefined,
    summary: raw["summary"],
    project: raw["project"],
    agent: raw["agent"],
    createdAt: raw["createdAt"],
    runtimeHandle: raw["runtimeHandle"],
    stateVersion: raw["stateVersion"],
    statePayload: raw["statePayload"],
    restoredAt: raw["restoredAt"],
    role: raw["role"],
    dashboardPort: raw["dashboardPort"] ? Number(raw["dashboardPort"]) : undefined,
    terminalWsPort: raw["terminalWsPort"] ? Number(raw["terminalWsPort"]) : undefined,
    directTerminalWsPort: raw["directTerminalWsPort"]
      ? Number(raw["directTerminalWsPort"])
      : undefined,
    opencodeSessionId: raw["opencodeSessionId"],
    pinnedSummary: raw["pinnedSummary"],
    userPrompt: raw["userPrompt"],
    displayName: raw["displayName"],
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
  return parseKeyValueContent(readFileSync(path, "utf-8"));
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

  if (metadata.tmuxName) data["tmuxName"] = metadata.tmuxName;
  if (metadata.issue) data["issue"] = metadata.issue;
  if (metadata.pr) data["pr"] = metadata.pr;
  if (metadata.prAutoDetect) data["prAutoDetect"] = metadata.prAutoDetect;
  if (metadata.summary) data["summary"] = metadata.summary;
  if (metadata.project) data["project"] = metadata.project;
  if (metadata.agent) data["agent"] = metadata.agent;
  if (metadata.createdAt) data["createdAt"] = metadata.createdAt;
  if (metadata.runtimeHandle) data["runtimeHandle"] = metadata.runtimeHandle;
  if (metadata.stateVersion) data["stateVersion"] = metadata.stateVersion;
  if (metadata.statePayload) data["statePayload"] = metadata.statePayload;
  if (metadata.restoredAt) data["restoredAt"] = metadata.restoredAt;
  if (metadata.role) data["role"] = metadata.role;
  if (metadata.dashboardPort !== undefined) data["dashboardPort"] = String(metadata.dashboardPort);
  if (metadata.terminalWsPort !== undefined)
    data["terminalWsPort"] = String(metadata.terminalWsPort);
  if (metadata.directTerminalWsPort !== undefined)
    data["directTerminalWsPort"] = String(metadata.directTerminalWsPort);
  if (metadata.opencodeSessionId) data["opencodeSessionId"] = metadata.opencodeSessionId;
  if (metadata.pinnedSummary) data["pinnedSummary"] = metadata.pinnedSummary;
  if (metadata.userPrompt) data["userPrompt"] = metadata.userPrompt;
  if (metadata.displayName) data["displayName"] = metadata.displayName;

  atomicWriteFileSync(path, serializeMetadata(data));
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
  mutateMetadata(dataDir, sessionId, (existing) => {
    return applyMetadataUpdates(existing, updates);
  }, { createIfMissing: true });
}

function applyMetadataUpdates(
  existing: Record<string, string>,
  updates: Partial<Record<string, string>>,
): Record<string, string> {
  let next = { ...existing };
  // Merge updates — remove keys set to empty string
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === "") {
      const { [key]: _removed, ...rest } = next;
      void _removed;
      next = rest;
    } else {
      next[key] = value;
    }
  }
  return next;
}

function normalizeMetadataRecord(data: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined && value !== ""),
  );
}

export function mutateMetadata(
  dataDir: string,
  sessionId: SessionId,
  updater: (existing: Record<string, string>) => Record<string, string>,
  options: { createIfMissing?: boolean } = {},
): Record<string, string> | null {
  const path = metadataPath(dataDir, sessionId);
  let existing: Record<string, string> = {};

  if (existsSync(path)) {
    existing = parseKeyValueContent(readFileSync(path, "utf-8"));
  } else if (!options.createIfMissing) {
    return null;
  }

  const next = normalizeMetadataRecord(updater({ ...existing }));

  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, serializeMetadata(next));
  return next;
}

export function readCanonicalLifecycle(
  dataDir: string,
  sessionId: SessionId,
): CanonicalSessionLifecycle | null {
  const raw = readMetadataRaw(dataDir, sessionId);
  if (!raw) return null;
  return parseCanonicalLifecycle(raw, { sessionId, status: validateStatus(raw["status"]) });
}

export function writeCanonicalLifecycle(
  dataDir: string,
  sessionId: SessionId,
  lifecycle: CanonicalSessionLifecycle,
  previousStatus?: SessionStatus,
): void {
  updateMetadata(
    dataDir,
    sessionId,
    buildLifecycleMetadataPatch(cloneLifecycle(lifecycle), previousStatus),
  );
}

export function updateCanonicalLifecycle(
  dataDir: string,
  sessionId: SessionId,
  updater: (current: CanonicalSessionLifecycle) => CanonicalSessionLifecycle,
  previousStatus?: SessionStatus,
): CanonicalSessionLifecycle | null {
  const raw = readMetadataRaw(dataDir, sessionId);
  if (!raw) return null;
  const current = parseCanonicalLifecycle(raw, {
    sessionId,
    status: validateStatus(raw["status"]),
  });
  const next = updater(cloneLifecycle(current));
  writeCanonicalLifecycle(dataDir, sessionId, next, previousStatus);
  return next;
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

  // NOTE: .ghcache/<sessionId>/ is intentionally NOT deleted here.
  // Cache files are small and useful for post-mortem analysis of wrapper
  // cache hit/miss behavior. listMetadata() already ignores hidden dirs.
}

/**
 * Read the latest archived metadata for a session.
 * Archive files are named `<sessionId>_<ISO-timestamp>` inside `<dataDir>/archive/`.
 * Returns null if no archived metadata exists.
 */
export function readArchivedMetadataRaw(
  dataDir: string,
  sessionId: SessionId,
): Record<string, string> | null {
  validateSessionId(sessionId);
  const archiveDir = join(dataDir, "archive");
  if (!existsSync(archiveDir)) return null;

  const prefix = `${sessionId}_`;
  let latest: string | null = null;

  for (const file of readdirSync(archiveDir)) {
    if (!file.startsWith(prefix)) continue;
    // Verify the separator is followed by a digit (start of ISO timestamp)
    // to avoid prefix collisions (e.g., "app" matching "app_v2_...")
    const charAfterPrefix = file[prefix.length];
    if (!charAfterPrefix || charAfterPrefix < "0" || charAfterPrefix > "9") continue;
    // Pick lexicographically last (ISO timestamps sort correctly)
    if (!latest || file > latest) {
      latest = file;
    }
  }

  if (!latest) return null;
  try {
    return parseKeyValueContent(readFileSync(join(archiveDir, latest), "utf-8"));
  } catch {
    return null;
  }
}

export function updateArchivedMetadata(
  dataDir: string,
  sessionId: SessionId,
  updates: Partial<Record<string, string>>,
): boolean {
  validateSessionId(sessionId);
  const archiveDir = join(dataDir, "archive");
  if (!existsSync(archiveDir)) return false;

  const prefix = `${sessionId}_`;
  let latest: string | null = null;

  for (const file of readdirSync(archiveDir)) {
    if (!file.startsWith(prefix)) continue;
    const charAfterPrefix = file[prefix.length];
    if (!charAfterPrefix || charAfterPrefix < "0" || charAfterPrefix > "9") continue;
    if (!latest || file > latest) latest = file;
  }

  if (!latest) return false;

  const archivePath = join(archiveDir, latest);
  let existing: Record<string, string>;
  try {
    existing = parseKeyValueContent(readFileSync(archivePath, "utf-8"));
  } catch {
    return false;
  }

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === "") {
      const { [key]: _, ...rest } = existing;
      existing = rest;
    } else {
      existing[key] = value;
    }
  }

  atomicWriteFileSync(archivePath, serializeMetadata(existing));
  return true;
}

/**
 * List all session IDs that have metadata files.
 */
export function listMetadata(dataDir: string): SessionId[] {
  const dir = dataDir;
  if (!existsSync(dir)) return [];

  return readdirSync(dir).filter((name) => {
    if (name === "archive" || name.startsWith(".")) return false;
    if (!SESSION_ID_COMPONENT_PATTERN.test(name)) return false;
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
