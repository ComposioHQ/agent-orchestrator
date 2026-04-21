/**
 * Session metadata read/write — JSON format.
 *
 * V2 storage layout:
 * - Session metadata: ~/.agent-orchestrator/projects/{projectId}/sessions/{sessionId}.json
 * - Orchestrator metadata: ~/.agent-orchestrator/projects/{projectId}/orchestrator.json
 * - Archives: ~/.agent-orchestrator/projects/{projectId}/archive/{sessionId}_{timestamp}.json
 *
 * Format: JSON (2-space indented), one object per file.
 * Status is computed on read from the lifecycle object, never stored.
 */

import {
  readFileSync,
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
import {
  buildLifecycleMetadataPatch,
  cloneLifecycle,
  parseCanonicalLifecycle,
} from "./lifecycle-state.js";
import { assertValidSessionIdComponent, SESSION_ID_COMPONENT_PATTERN } from "./utils/session-id.js";
import { validateStatus } from "./utils/validation.js";
import { compactTimestamp } from "./paths.js";

const JSON_EXTENSION = ".json";

/** Serialize metadata to formatted JSON. */
function serializeMetadata(data: Record<string, unknown>): string {
  return JSON.stringify(data, null, 2) + "\n";
}

/** Parse JSON metadata file content. */
function parseMetadataContent(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

function validateSessionId(sessionId: SessionId): void {
  assertValidSessionIdComponent(sessionId);
}

/** Get the metadata file path for a session (with .json extension). */
function metadataPath(dataDir: string, sessionId: SessionId): string {
  validateSessionId(sessionId);
  return join(dataDir, `${sessionId}${JSON_EXTENSION}`);
}

/**
 * Read metadata for a session. Returns null if the file doesn't exist.
 */
export function readMetadata(dataDir: string, sessionId: SessionId): SessionMetadata | null {
  const path = metadataPath(dataDir, sessionId);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8").trim();
  if (!content) return null; // empty file (e.g. from reserveSessionId)
  const raw = parseMetadataContent(content);

  return {
    worktree: (raw["worktree"] as string) ?? "",
    branch: (raw["branch"] as string) ?? "",
    status: (raw["status"] as string) ?? "unknown",
    tmuxName: raw["tmuxName"] as string | undefined,
    issue: raw["issue"] as string | undefined,
    pr: raw["pr"] as string | undefined,
    prAutoDetect:
      raw["prAutoDetect"] === "off" ? "off" : raw["prAutoDetect"] === "on" ? "on" : undefined,
    summary: raw["summary"] as string | undefined,
    project: raw["project"] as string | undefined,
    agent: raw["agent"] as string | undefined,
    createdAt: raw["createdAt"] as string | undefined,
    runtimeHandle: typeof raw["runtimeHandle"] === "object" && raw["runtimeHandle"] !== null
      ? JSON.stringify(raw["runtimeHandle"])
      : raw["runtimeHandle"] as string | undefined,
    stateVersion: raw["stateVersion"] as string | undefined,
    statePayload: typeof raw["statePayload"] === "object" && raw["statePayload"] !== null
      ? JSON.stringify(raw["statePayload"])
      : raw["statePayload"] as string | undefined,
    restoredAt: raw["restoredAt"] as string | undefined,
    role: raw["role"] as string | undefined,
    dashboardPort: typeof raw["dashboardPort"] === "number" ? raw["dashboardPort"] : undefined,
    terminalWsPort: typeof raw["terminalWsPort"] === "number" ? raw["terminalWsPort"] : undefined,
    directTerminalWsPort: typeof raw["directTerminalWsPort"] === "number"
      ? raw["directTerminalWsPort"]
      : undefined,
    opencodeSessionId: raw["opencodeSessionId"] as string | undefined,
    pinnedSummary: raw["pinnedSummary"] as string | undefined,
    userPrompt: raw["userPrompt"] as string | undefined,
  };
}

/**
 * Read raw metadata as a plain object (for arbitrary key access).
 */
export function readMetadataRaw(
  dataDir: string,
  sessionId: SessionId,
): Record<string, string> | null {
  const path = metadataPath(dataDir, sessionId);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return null; // empty file (e.g. from reserveSessionId)
  const raw = parseMetadataContent(content);
  // Flatten to Record<string, string> for backward compatibility.
  // Objects (runtimeHandle, statePayload) are JSON-stringified.
  return flattenToStringRecord(raw);
}

/** Flatten a JSON object to a Record<string, string> for backward compat. */
function flattenToStringRecord(data: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      result[key] = JSON.stringify(value);
    } else {
      result[key] = String(value);
    }
  }
  return result;
}

/** Unflatten a Record<string, string> to proper types for JSON storage. */
function unflattenFromStringRecord(data: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const jsonFields = new Set(["runtimeHandle", "statePayload"]);
  const numberFields = new Set(["dashboardPort", "terminalWsPort", "directTerminalWsPort"]);

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === "") continue;
    if (jsonFields.has(key)) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else if (numberFields.has(key)) {
      const num = Number(value);
      result[key] = Number.isFinite(num) ? num : value;
    } else {
      result[key] = value;
    }
  }
  return result;
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

  const data: Record<string, unknown> = {
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
  if (metadata.runtimeHandle) {
    try {
      data["runtimeHandle"] = JSON.parse(metadata.runtimeHandle);
    } catch {
      data["runtimeHandle"] = metadata.runtimeHandle;
    }
  }
  if (metadata.stateVersion) data["stateVersion"] = metadata.stateVersion;
  if (metadata.statePayload) {
    try {
      data["statePayload"] = JSON.parse(metadata.statePayload);
    } catch {
      data["statePayload"] = metadata.statePayload;
    }
  }
  if (metadata.restoredAt) data["restoredAt"] = metadata.restoredAt;
  if (metadata.role) data["role"] = metadata.role;
  if (metadata.dashboardPort !== undefined) data["dashboardPort"] = metadata.dashboardPort;
  if (metadata.terminalWsPort !== undefined) data["terminalWsPort"] = metadata.terminalWsPort;
  if (metadata.directTerminalWsPort !== undefined)
    data["directTerminalWsPort"] = metadata.directTerminalWsPort;
  if (metadata.opencodeSessionId) data["opencodeSessionId"] = metadata.opencodeSessionId;
  if (metadata.pinnedSummary) data["pinnedSummary"] = metadata.pinnedSummary;
  if (metadata.userPrompt) data["userPrompt"] = metadata.userPrompt;

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
    const content = readFileSync(path, "utf-8");
    const raw = parseMetadataContent(content);
    existing = flattenToStringRecord(raw);
  } else if (!options.createIfMissing) {
    return null;
  }

  const next = normalizeMetadataRecord(updater({ ...existing }));

  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, serializeMetadata(unflattenFromStringRecord(next)));
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
 * Optionally archive it to a sibling `archive/` directory.
 */
export function deleteMetadata(dataDir: string, sessionId: SessionId, archive = true): void {
  const path = metadataPath(dataDir, sessionId);
  if (!existsSync(path)) return;

  if (archive) {
    const archiveDir = join(dataDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const timestamp = compactTimestamp(new Date());
    const archivePath = join(archiveDir, `${sessionId}_${timestamp}${JSON_EXTENSION}`);
    atomicWriteFileSync(archivePath, readFileSync(path, "utf-8"));
  }

  unlinkSync(path);
}

/**
 * Read the latest archived metadata for a session.
 * Archive files are named `<sessionId>_<compact-timestamp>.json` inside `<projectDir>/archive/`.
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
    // Verify the separator is followed by a digit (start of timestamp)
    const charAfterPrefix = file[prefix.length];
    if (!charAfterPrefix || charAfterPrefix < "0" || charAfterPrefix > "9") continue;
    // Pick lexicographically last (timestamps sort correctly)
    if (!latest || file > latest) {
      latest = file;
    }
  }

  if (!latest) return null;
  try {
    const content = readFileSync(join(archiveDir, latest), "utf-8");
    const raw = parseMetadataContent(content);
    return flattenToStringRecord(raw);
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
    const content = readFileSync(archivePath, "utf-8");
    const raw = parseMetadataContent(content);
    existing = flattenToStringRecord(raw);
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

  atomicWriteFileSync(archivePath, serializeMetadata(unflattenFromStringRecord(existing)));
  return true;
}

/**
 * List all session IDs that have metadata files.
 * Reads .json files from the sessions directory.
 */
export function listMetadata(dataDir: string): SessionId[] {
  const dir = dataDir;
  if (!existsSync(dir)) return [];

  return readdirSync(dir).filter((name) => {
    // Must be a .json file
    if (!name.endsWith(JSON_EXTENSION)) return false;
    const baseName = name.slice(0, -JSON_EXTENSION.length);
    if (!baseName || baseName === "archive" || baseName.startsWith(".")) return false;
    if (!SESSION_ID_COMPONENT_PATTERN.test(baseName)) return false;
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  }).map((name) => name.slice(0, -JSON_EXTENSION.length));
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
