/**
 * Session metadata read/write — JSON format.
 *
 * V2 storage layout:
 * - Session metadata: ~/.agent-orchestrator/projects/{projectId}/sessions/{sessionId}.json
 * - Orchestrator metadata: ~/.agent-orchestrator/projects/{projectId}/orchestrator.json
 * - Archives: ~/.agent-orchestrator/projects/{projectId}/archive/{sessionId}_{timestamp}.json
 *
 * Format: JSON (2-space indented), one object per file.
 * Status is always computed on read from lifecycle (never persisted).
 * Pre-lifecycle sessions retain a stored status field from migration.
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
import type { CanonicalSessionLifecycle, RuntimeHandle, SessionId, SessionMetadata } from "./types.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import {
  buildLifecycleMetadataPatch,
  cloneLifecycle,
  deriveLegacyStatus,
  parseCanonicalLifecycle,
} from "./lifecycle-state.js";
import { assertValidSessionIdComponent, SESSION_ID_COMPONENT_PATTERN } from "./utils/session-id.js";
import { flattenToStringRecord } from "./utils/metadata-flatten.js";
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

/**
 * Extract the lifecycle object from raw metadata.
 * Supports both V2 format ("lifecycle" key) and legacy format ("statePayload" + "stateVersion").
 */
function parseLifecycleField(raw: Record<string, unknown>): CanonicalSessionLifecycle | undefined {
  // V2 format: lifecycle is stored directly as an object
  if (raw["lifecycle"] && typeof raw["lifecycle"] === "object") {
    return raw["lifecycle"] as CanonicalSessionLifecycle;
  }
  // Legacy format: statePayload is a JSON string or pre-parsed object
  if (raw["statePayload"] && raw["stateVersion"] === "2") {
    if (typeof raw["statePayload"] === "object") {
      return raw["statePayload"] as CanonicalSessionLifecycle;
    }
    if (typeof raw["statePayload"] === "string") {
      try {
        return JSON.parse(raw["statePayload"]) as CanonicalSessionLifecycle;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Parse a runtimeHandle from raw metadata (may be object or JSON string). */
function parseRuntimeHandleField(value: unknown): RuntimeHandle | undefined {
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj["id"] === "string" && typeof obj["runtimeName"] === "string") {
      return value as RuntimeHandle;
    }
    return undefined;
  }
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (typeof parsed["id"] === "string" && typeof parsed["runtimeName"] === "string") {
        return parsed as unknown as RuntimeHandle;
      }
    } catch { /* not valid JSON */ }
  }
  return undefined;
}

function parseDashboardField(raw: Record<string, unknown>): SessionMetadata["dashboard"] {
  // New format: nested dashboard object
  if (typeof raw["dashboard"] === "object" && raw["dashboard"] !== null) {
    const d = raw["dashboard"] as Record<string, unknown>;
    return {
      port: typeof d["port"] === "number" ? d["port"] : undefined,
      terminalWsPort: typeof d["terminalWsPort"] === "number" ? d["terminalWsPort"] : undefined,
      directTerminalWsPort: typeof d["directTerminalWsPort"] === "number" ? d["directTerminalWsPort"] : undefined,
    };
  }
  // Legacy format: flat fields
  const port = typeof raw["dashboardPort"] === "number" ? raw["dashboardPort"] : undefined;
  const terminalWsPort = typeof raw["terminalWsPort"] === "number" ? raw["terminalWsPort"] : undefined;
  const directTerminalWsPort = typeof raw["directTerminalWsPort"] === "number" ? raw["directTerminalWsPort"] : undefined;
  if (port !== undefined || terminalWsPort !== undefined || directTerminalWsPort !== undefined) {
    return { port, terminalWsPort, directTerminalWsPort };
  }
  return undefined;
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

  // Derive status: lifecycle-derived (single source of truth) → stored fallback
  const lifecycle = parseLifecycleField(raw);
  const storedStatus = raw["status"] as string | undefined;
  const status = lifecycle ? deriveLegacyStatus(lifecycle) : (storedStatus ?? "unknown");

  return {
    worktree: (raw["worktree"] as string) ?? "",
    branch: (raw["branch"] as string) ?? "",
    status,
    tmuxName: raw["tmuxName"] as string | undefined,
    issue: raw["issue"] as string | undefined,
    pr: raw["pr"] as string | undefined,
    prAutoDetect:
      raw["prAutoDetect"] === "off" || raw["prAutoDetect"] === "false" || raw["prAutoDetect"] === false ? false :
      raw["prAutoDetect"] === "on" || raw["prAutoDetect"] === "true" || raw["prAutoDetect"] === true ? true : undefined,
    summary: raw["summary"] as string | undefined,
    project: raw["project"] as string | undefined,
    agent: raw["agent"] as string | undefined,
    createdAt: raw["createdAt"] as string | undefined,
    runtimeHandle: parseRuntimeHandleField(raw["runtimeHandle"]),
    lifecycle,
    restoredAt: raw["restoredAt"] as string | undefined,
    role: raw["role"] as string | undefined,
    dashboard: parseDashboardField(raw),
    opencodeSessionId: raw["opencodeSessionId"] as string | undefined,
    pinnedSummary: raw["pinnedSummary"] as string | undefined,
    userPrompt: raw["userPrompt"] as string | undefined,
    displayName: raw["displayName"] as string | undefined,
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
  // Lifecycle is the single source of truth for status — always override stored status
  if (raw["lifecycle"]) {
    const lifecycle = parseLifecycleField(raw);
    if (lifecycle) {
      raw["status"] = deriveLegacyStatus(lifecycle);
    }
  }
  // Flatten to Record<string, string> for backward compatibility.
  // Objects (runtimeHandle, statePayload) are JSON-stringified.
  return flattenToStringRecord(raw);
}

/** Fields that are stored as JSON objects and should be parsed when unflattening. */
const jsonFields = new Set([
  "runtimeHandle", "lifecycle", "statePayload", "dashboard",
  "agentReport", "reportWatcher",
]);

/** Unflatten a Record<string, string> to proper types for JSON storage. */
function unflattenFromStringRecord(data: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const numberFields = new Set(["dashboardPort", "terminalWsPort", "directTerminalWsPort"]);
  const booleanFields = new Set(["prAutoDetect"]);

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === "") continue;
    if (booleanFields.has(key)) {
      result[key] = value === "on" || value === "true" ? true : value === "off" || value === "false" ? false : value;
    } else if (numberFields.has(key)) {
      const num = Number(value);
      result[key] = Number.isFinite(num) ? num : value;
    } else if (jsonFields.has(key) && (value.startsWith("{") || value.startsWith("["))) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
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
  if (metadata.prAutoDetect !== undefined) data["prAutoDetect"] = metadata.prAutoDetect;
  if (metadata.summary) data["summary"] = metadata.summary;
  if (metadata.project) data["project"] = metadata.project;
  if (metadata.agent) data["agent"] = metadata.agent;
  if (metadata.createdAt) data["createdAt"] = metadata.createdAt;
  if (metadata.runtimeHandle) data["runtimeHandle"] = metadata.runtimeHandle;
  if (metadata.lifecycle) data["lifecycle"] = metadata.lifecycle;
  if (metadata.restoredAt) data["restoredAt"] = metadata.restoredAt;
  if (metadata.role) data["role"] = metadata.role;
  if (metadata.dashboard) data["dashboard"] = metadata.dashboard;
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
    const content = readFileSync(path, "utf-8").trim();
    if (content) {
      const raw = parseMetadataContent(content);
      existing = flattenToStringRecord(raw);
    }
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
): void {
  updateMetadata(
    dataDir,
    sessionId,
    buildLifecycleMetadataPatch(cloneLifecycle(lifecycle)),
  );
}

export function updateCanonicalLifecycle(
  dataDir: string,
  sessionId: SessionId,
  updater: (current: CanonicalSessionLifecycle) => CanonicalSessionLifecycle,
): CanonicalSessionLifecycle | null {
  const raw = readMetadataRaw(dataDir, sessionId);
  if (!raw) return null;
  const current = parseCanonicalLifecycle(raw, {
    sessionId,
    status: validateStatus(raw["status"]),
  });
  const next = updater(cloneLifecycle(current));
  writeCanonicalLifecycle(dataDir, sessionId, next);
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
 * Archive files are named `<sessionId>_<compact-timestamp>.json` inside `<sessionsDir>/archive/`.
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
