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
import { join, dirname, resolve, isAbsolute, sep } from "node:path";
import type {
  SessionId,
  SessionMetadata,
  PlanArtifact,
  PlanBlobWriteInput,
  PlanStatus,
} from "./types.js";

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
const VALID_PLAN_ID = /^[a-zA-Z0-9._-]+$/;
const VALID_PLAN_STATUSES: ReadonlySet<PlanStatus> = new Set([
  "draft",
  "validated",
  "superseded",
]);
const PLAN_DIR = "plans";

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

/** Parse a positive integer from metadata, returning undefined on invalid values. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** Normalize plan status from metadata. Unknown values are ignored for compatibility. */
function parsePlanStatus(raw: string | undefined): PlanStatus | undefined {
  if (!raw) return undefined;
  if (VALID_PLAN_STATUSES.has(raw as PlanStatus)) return raw as PlanStatus;
  return undefined;
}

/** Validate plan identifiers used for metadata + file naming. */
function validatePlanId(planId: string): void {
  if (!planId || !VALID_PLAN_ID.test(planId)) {
    throw new Error(`Invalid plan ID: ${planId}`);
  }
}

/** Validate plan version values. */
function validatePlanVersion(planVersion: number): void {
  if (!Number.isInteger(planVersion) || planVersion <= 0) {
    throw new Error(`Invalid plan version: ${planVersion}`);
  }
}

/** Validate plan status values. */
function validatePlanStatus(planStatus: PlanStatus): void {
  if (!VALID_PLAN_STATUSES.has(planStatus)) {
    throw new Error(`Invalid plan status: ${planStatus}`);
  }
}

/** Build canonical relative plan path for a given session plan artifact. */
function buildPlanPath(sessionId: SessionId, planId: string, planVersion: number): string {
  validateSessionId(sessionId);
  validatePlanId(planId);
  validatePlanVersion(planVersion);
  return join(PLAN_DIR, sessionId, `${planId}.v${planVersion}.json`);
}

/** Resolve a plan path and ensure it stays inside the session metadata directory. */
function resolvePlanPath(dataDir: string, planPath: string): string {
  const baseDir = resolve(dataDir);
  const resolvedPath = isAbsolute(planPath) ? resolve(planPath) : resolve(baseDir, planPath);
  if (resolvedPath !== baseDir && !resolvedPath.startsWith(`${baseDir}${sep}`)) {
    throw new Error(`Invalid plan path outside metadata directory: ${planPath}`);
  }
  return resolvedPath;
}

/** Parse an on-disk plan artifact. */
function readPlanArtifactFromPath<TBlob>(
  dataDir: string,
  planPath: string,
  fallback: {
    planId: string;
    planVersion: number;
    planStatus: PlanStatus;
  },
): PlanArtifact<TBlob> | null {
  let absolutePath: string;
  try {
    absolutePath = resolvePlanPath(dataDir, planPath);
  } catch {
    return null;
  }
  if (!existsSync(absolutePath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf-8"));
  } catch {
    return null;
  }

  const nowIso = new Date().toISOString();
  const candidate = parsed as Partial<PlanArtifact<TBlob>>;
  const hasWrappedBlob =
    typeof candidate === "object" &&
    candidate !== null &&
    Object.prototype.hasOwnProperty.call(candidate, "blob");

  return {
    planId: typeof candidate.planId === "string" ? candidate.planId : fallback.planId,
    planVersion:
      typeof candidate.planVersion === "number" && Number.isInteger(candidate.planVersion)
        ? candidate.planVersion
        : fallback.planVersion,
    planStatus:
      typeof candidate.planStatus === "string" &&
      VALID_PLAN_STATUSES.has(candidate.planStatus as PlanStatus)
        ? (candidate.planStatus as PlanStatus)
        : fallback.planStatus,
    planPath,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : nowIso,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : nowIso,
    blob: hasWrappedBlob ? (candidate.blob as TBlob) : (parsed as TBlob),
  };
}

/** Persist a plan artifact JSON document to disk. */
function writePlanArtifact<TBlob>(dataDir: string, artifact: PlanArtifact<TBlob>): void {
  const absolutePath = resolvePlanPath(dataDir, artifact.planPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
}

/**
 * Read metadata for a session. Returns null if the file doesn't exist.
 */
export function readMetadata(dataDir: string, sessionId: SessionId): SessionMetadata | null {
  const path = metadataPath(dataDir, sessionId);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8");
  const raw = parseMetadataFile(content);
  const planVersion = parsePositiveInt(raw["planVersion"]);
  const planStatus = parsePlanStatus(raw["planStatus"]);

  return {
    worktree: raw["worktree"] ?? "",
    branch: raw["branch"] ?? "",
    status: raw["status"] ?? "unknown",
    tmuxName: raw["tmuxName"],
    issue: raw["issue"],
    pr: raw["pr"],
    summary: raw["summary"],
    project: raw["project"],
    agent: raw["agent"],
    createdAt: raw["createdAt"],
    runtimeHandle: raw["runtimeHandle"],
    dashboardPort: raw["dashboardPort"] ? Number(raw["dashboardPort"]) : undefined,
    terminalWsPort: raw["terminalWsPort"] ? Number(raw["terminalWsPort"]) : undefined,
    directTerminalWsPort: raw["directTerminalWsPort"] ? Number(raw["directTerminalWsPort"]) : undefined,
    planId: raw["planId"],
    planVersion,
    planStatus,
    planPath: raw["planPath"],
    evidenceSchemaVersion: raw["evidenceSchemaVersion"],
    evidenceDir: raw["evidenceDir"],
    evidenceCommandLog: raw["evidenceCommandLog"],
    evidenceTestsRun: raw["evidenceTestsRun"],
    evidenceChangedPaths: raw["evidenceChangedPaths"],
    evidenceKnownRisks: raw["evidenceKnownRisks"],
    escalationState: raw["escalationState"],
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

  if (metadata.tmuxName) data["tmuxName"] = metadata.tmuxName;
  if (metadata.issue) data["issue"] = metadata.issue;
  if (metadata.pr) data["pr"] = metadata.pr;
  if (metadata.summary) data["summary"] = metadata.summary;
  if (metadata.project) data["project"] = metadata.project;
  if (metadata.agent) data["agent"] = metadata.agent;
  if (metadata.createdAt) data["createdAt"] = metadata.createdAt;
  if (metadata.runtimeHandle) data["runtimeHandle"] = metadata.runtimeHandle;
  if (metadata.dashboardPort !== undefined)
    data["dashboardPort"] = String(metadata.dashboardPort);
  if (metadata.terminalWsPort !== undefined)
    data["terminalWsPort"] = String(metadata.terminalWsPort);
  if (metadata.directTerminalWsPort !== undefined)
    data["directTerminalWsPort"] = String(metadata.directTerminalWsPort);
  if (metadata.planId) data["planId"] = metadata.planId;
  if (metadata.planVersion !== undefined) data["planVersion"] = String(metadata.planVersion);
  if (metadata.planStatus) data["planStatus"] = metadata.planStatus;
  if (metadata.planPath) data["planPath"] = metadata.planPath;
  if (metadata.evidenceSchemaVersion)
    data["evidenceSchemaVersion"] = metadata.evidenceSchemaVersion;
  if (metadata.evidenceDir) data["evidenceDir"] = metadata.evidenceDir;
  if (metadata.evidenceCommandLog) data["evidenceCommandLog"] = metadata.evidenceCommandLog;
  if (metadata.evidenceTestsRun) data["evidenceTestsRun"] = metadata.evidenceTestsRun;
  if (metadata.evidenceChangedPaths)
    data["evidenceChangedPaths"] = metadata.evidenceChangedPaths;
  if (metadata.evidenceKnownRisks) data["evidenceKnownRisks"] = metadata.evidenceKnownRisks;
  if (metadata.escalationState) data["escalationState"] = metadata.escalationState;

  writeFileSync(path, serializeMetadata(data), "utf-8");
}

/**
 * Write a versioned plan blob for a session and persist lifecycle metadata.
 * If a different plan artifact was previously active, it is marked as superseded.
 */
export function writePlanBlob<TBlob>(
  dataDir: string,
  sessionId: SessionId,
  plan: PlanBlobWriteInput<TBlob>,
): PlanArtifact<TBlob> {
  validateSessionId(sessionId);
  validatePlanId(plan.planId);
  validatePlanVersion(plan.planVersion);

  const planStatus = plan.planStatus ?? "draft";
  validatePlanStatus(planStatus);

  const nextPlanPath = buildPlanPath(sessionId, plan.planId, plan.planVersion);
  const nowIso = new Date().toISOString();

  const existingMeta = readMetadata(dataDir, sessionId);
  const existingPlanPath = existingMeta?.planPath;
  const existingPlanId = existingMeta?.planId;
  const existingPlanVersion = existingMeta?.planVersion;
  const existingPlanStatus = existingMeta?.planStatus;

  if (
    existingPlanPath &&
    existingPlanStatus !== "superseded" &&
    (existingPlanPath !== nextPlanPath ||
      existingPlanId !== plan.planId ||
      existingPlanVersion !== plan.planVersion)
  ) {
    const oldPlan = readPlanArtifactFromPath<unknown>(dataDir, existingPlanPath, {
      planId: existingPlanId ?? "legacy-plan",
      planVersion: existingPlanVersion ?? 1,
      planStatus: existingPlanStatus ?? "draft",
    });
    if (oldPlan) {
      const superseded: PlanArtifact<unknown> = {
        ...oldPlan,
        planStatus: "superseded",
        updatedAt: nowIso,
      };
      writePlanArtifact(dataDir, superseded);
    }
  }

  const existingCurrent = readPlanArtifactFromPath<TBlob>(dataDir, nextPlanPath, {
    planId: plan.planId,
    planVersion: plan.planVersion,
    planStatus,
  });

  const artifact: PlanArtifact<TBlob> = {
    planId: plan.planId,
    planVersion: plan.planVersion,
    planStatus,
    planPath: nextPlanPath,
    createdAt: existingCurrent?.createdAt ?? nowIso,
    updatedAt: nowIso,
    blob: plan.blob,
  };

  writePlanArtifact(dataDir, artifact);
  updateMetadata(dataDir, sessionId, {
    planId: artifact.planId,
    planVersion: String(artifact.planVersion),
    planStatus: artifact.planStatus,
    planPath: artifact.planPath,
  });

  return artifact;
}

/**
 * Read the current persisted plan blob for a session.
 * Returns null when the session has no plan metadata or no readable blob.
 */
export function readPlanBlob<TBlob>(dataDir: string, sessionId: SessionId): PlanArtifact<TBlob> | null {
  const meta = readMetadata(dataDir, sessionId);
  if (!meta?.planId || !meta.planVersion) return null;

  const planStatus = meta.planStatus ?? "draft";
  const planPath = meta.planPath ?? buildPlanPath(sessionId, meta.planId, meta.planVersion);
  return readPlanArtifactFromPath<TBlob>(dataDir, planPath, {
    planId: meta.planId,
    planVersion: meta.planVersion,
    planStatus,
  });
}

/**
 * Transition the current plan lifecycle status in metadata and its blob.
 * Returns null when no current plan exists for the session.
 */
export function updatePlanStatus(
  dataDir: string,
  sessionId: SessionId,
  planStatus: PlanStatus,
): PlanArtifact<unknown> | null {
  validatePlanStatus(planStatus);

  const current = readPlanBlob<unknown>(dataDir, sessionId);
  if (!current) return null;

  const updated: PlanArtifact<unknown> = {
    ...current,
    planStatus,
    updatedAt: new Date().toISOString(),
  };
  writePlanArtifact(dataDir, updated);
  updateMetadata(dataDir, sessionId, { planStatus });
  return updated;
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
    return parseMetadataFile(readFileSync(join(archiveDir, latest), "utf-8"));
  } catch {
    return null;
  }
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
