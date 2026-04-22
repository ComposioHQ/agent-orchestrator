/**
 * Storage V2 migration — converts old hash-based storage layout to
 * the new `projects/{projectId}/` layout with JSON metadata.
 *
 * Old layout: ~/.agent-orchestrator/{12-hex}-{projectId}/sessions/{sessionId}
 * New layout: ~/.agent-orchestrator/projects/{projectId}/sessions/{sessionId}.json
 *
 * This module is intentionally self-contained — it must NOT import
 * deriveStorageKey, legacyProjectHash, or any old hash functions.
 * Detection uses a single regex: /^([0-9a-f]{12})-(.+)$/
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseKeyValueContent } from "../key-value.js";
import { compactTimestamp } from "../paths.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex to detect old hash-based directory names: {12-hex}-{projectId}. */
const HASH_DIR_PATTERN = /^([0-9a-f]{12})-(.+)$/;

/** Regex to detect bare 12-hex hash directories (no project suffix). */
const BARE_HASH_DIR_PATTERN = /^([0-9a-f]{12})$/;

/** Regex to detect .migrated directories (for rollback). */
const MIGRATED_DIR_PATTERN = /^([0-9a-f]{12})-(.+)\.migrated$/;

/** Regex to detect bare .migrated directories. */
const BARE_MIGRATED_DIR_PATTERN = /^([0-9a-f]{12})\.migrated$/;

/** Directory name suffixes that are NOT project data and must be skipped by migration. */
const NON_PROJECT_SUFFIXES = new Set(["observability"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationOptions {
  /** Force migration even if active tmux sessions are detected. */
  force?: boolean;
  /** Dry run — report what would be done without making changes. */
  dryRun?: boolean;
  /** Override the base AO directory (for testing). */
  aoBaseDir?: string;
  /** Override the global config path (for testing). */
  globalConfigPath?: string;
  /** Log function (defaults to console.log). */
  log?: (message: string) => void;
}

export interface RollbackOptions {
  /** Override the base AO directory (for testing). */
  aoBaseDir?: string;
  /** Override the global config path (for testing). */
  globalConfigPath?: string;
  /** Log function (defaults to console.log). */
  log?: (message: string) => void;
}

export interface MigrationResult {
  projects: number;
  sessions: number;
  archives: number;
  worktrees: number;
  emptyDirsDeleted: number;
  strayWorktreesMoved: number;
}

export interface HashDirEntry {
  /** Full path to the hash-based directory. */
  path: string;
  /** The 12-char hex hash prefix. */
  hash: string;
  /** The project ID extracted from the directory name. */
  projectId: string;
  /** Whether the directory is empty (no sessions or worktrees). */
  empty: boolean;
}

// ---------------------------------------------------------------------------
// Inventory — detect old hash-based directories
// ---------------------------------------------------------------------------

export function inventoryHashDirs(aoBaseDir: string, globalConfigPath?: string): HashDirEntry[] {
  if (!existsSync(aoBaseDir)) return [];

  // Build a storageKey→projectId lookup from global config (for bare hash dirs)
  const storageKeyToProject = buildStorageKeyLookup(globalConfigPath);

  const entries: HashDirEntry[] = [];
  for (const name of readdirSync(aoBaseDir)) {
    let hash: string;
    let projectId: string;

    const hashNameMatch = HASH_DIR_PATTERN.exec(name);
    const bareHashMatch = BARE_HASH_DIR_PATTERN.exec(name);

    if (hashNameMatch) {
      hash = hashNameMatch[1];
      projectId = hashNameMatch[2];
      // Skip non-project directories (e.g. {hash}-observability)
      if (NON_PROJECT_SUFFIXES.has(projectId)) continue;
    } else if (bareHashMatch) {
      hash = bareHashMatch[1];
      // Derive projectId: config lookup → session metadata → fallback to hash
      projectId = storageKeyToProject.get(hash) ?? deriveProjectIdFromDir(join(aoBaseDir, name)) ?? hash;
    } else {
      continue;
    }

    const dirPath = join(aoBaseDir, name);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // A directory is empty if it has no session files and no worktrees
    const sessionsDir = join(dirPath, "sessions");
    const worktreesDir = join(dirPath, "worktrees");
    const hasSessions = existsSync(sessionsDir) && readdirSync(sessionsDir).some(
      (f) => !f.startsWith(".") && f !== "archive",
    );
    const hasWorktrees = existsSync(worktreesDir) && readdirSync(worktreesDir).length > 0;
    const hasArchive = existsSync(join(sessionsDir, "archive")) &&
      readdirSync(join(sessionsDir, "archive")).length > 0;

    entries.push({
      path: dirPath,
      hash,
      projectId,
      empty: !hasSessions && !hasWorktrees && !hasArchive,
    });
  }

  return entries;
}

/**
 * Build a storageKey → projectId lookup from the global config.
 * Used to identify which project a bare hash directory belongs to.
 */
function buildStorageKeyLookup(globalConfigPath?: string): Map<string, string> {
  const lookup = new Map<string, string>();
  if (!globalConfigPath || !existsSync(globalConfigPath)) return lookup;

  try {
    const content = readFileSync(globalConfigPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const projects = parsed?.["projects"] as Record<string, Record<string, unknown>> | undefined;
    if (!projects || typeof projects !== "object") return lookup;

    for (const [projectId, entry] of Object.entries(projects)) {
      if (entry && typeof entry === "object" && typeof entry["storageKey"] === "string") {
        lookup.set(entry["storageKey"], projectId);
      }
    }
  } catch {
    // Config unreadable — proceed without lookup
  }
  return lookup;
}

/**
 * Extract known project name prefixes from the global config.
 * Used by detectActiveSessions to match V2 tmux session names.
 */
function extractProjectPrefixes(globalConfigPath?: string): string[] {
  if (!globalConfigPath || !existsSync(globalConfigPath)) return [];

  try {
    const content = readFileSync(globalConfigPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const projects = parsed?.["projects"] as Record<string, Record<string, unknown>> | undefined;
    if (!projects || typeof projects !== "object") return [];

    // Project IDs themselves are often used as tmux prefixes
    return Object.keys(projects);
  } catch {
    return [];
  }
}

/**
 * Try to derive a projectId from session metadata files inside a directory.
 * Reads the first session file that has a "project" field.
 */
function deriveProjectIdFromDir(dirPath: string): string | null {
  const sessionsDir = join(dirPath, "sessions");
  if (!existsSync(sessionsDir)) return null;

  try {
    for (const file of readdirSync(sessionsDir)) {
      if (file === "archive" || file.startsWith(".")) continue;
      const filePath = join(sessionsDir, file);
      try {
        if (!statSync(filePath).isFile()) continue;
        const content = readFileSync(filePath, "utf-8").trim();
        if (!content) continue;

        // Try JSON first, then key=value
        let projectField: string | undefined;
        if (content.startsWith("{")) {
          const parsed = JSON.parse(content) as Record<string, unknown>;
          projectField = typeof parsed["project"] === "string" ? parsed["project"] : undefined;
        } else {
          const kv = parseKeyValueContent(content);
          projectField = kv["project"];
        }
        if (projectField) return projectField;
      } catch {
        continue;
      }
    }
  } catch {
    // Can't read sessions dir
  }
  return null;
}

// ---------------------------------------------------------------------------
// Active session detection
// ---------------------------------------------------------------------------

/**
 * Detect active AO tmux sessions. Returns session names that match
 * either legacy ({hash}-{prefix}-{num}) or V2 ({prefix}-{num}) patterns.
 *
 * Legacy names:  {12-hex}-{prefix}-{num}   (e.g. abcdef012345-ao-1)
 * V2 names:      {prefix}-{num}            (e.g. ao-17, app-orchestrator-1)
 *
 * To distinguish V2 names from unrelated tmux sessions, we match:
 * - Any session ending in `-orchestrator-{num}` (always AO)
 * - Sessions matching known AO prefixes: ao-{num}
 * - If knownPrefixes are provided, also match {prefix}-{num}
 */
export async function detectActiveSessions(knownPrefixes?: string[]): Promise<string[]> {
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    if (!output) return [];

    // Legacy pattern: {12-hex}-{anything}-{num}
    const legacyPattern = /^[0-9a-f]{12}-.+-\d+$/;
    // V2: any orchestrator session (always AO)
    const v2OrchestratorPattern = /^.+-orchestrator-\d+$/;
    // V2: default "ao" prefix
    const v2DefaultPattern = /^ao-\d+$/;

    // Build V2 prefix patterns from known project prefixes
    const v2PrefixPatterns = (knownPrefixes ?? [])
      .filter((p) => p && p !== "ao") // "ao" already covered above
      .map((p) => new RegExp(`^${escapeRegExp(p)}-\\d+$`));

    return output.split("\n").filter((name) => {
      if (legacyPattern.test(name)) return true;
      if (v2OrchestratorPattern.test(name)) return true;
      if (v2DefaultPattern.test(name)) return true;
      return v2PrefixPatterns.some((pattern) => pattern.test(name));
    });
  } catch {
    // tmux not available or no sessions
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Key-value to JSON conversion
// ---------------------------------------------------------------------------

/**
 * Convert old key=value metadata content to a JSON object.
 * Handles all the grouping and type conversions specified in STORAGE_REDESIGN.md.
 */
export function convertKeyValueToJson(kvContent: string): Record<string, unknown> {
  const kv = parseKeyValueContent(kvContent);
  const result: Record<string, unknown> = {};

  // Direct string fields
  const stringFields = [
    "project", "agent", "createdAt", "branch", "tmuxName",
    "issue", "pr", "summary", "restoredAt", "role",
    "opencodeSessionId", "pinnedSummary", "userPrompt",
  ];
  for (const field of stringFields) {
    if (kv[field]) result[field] = kv[field];
  }

  // Worktree: keep as-is (will be made relative in the migration step)
  if (kv["worktree"]) result["worktree"] = kv["worktree"];

  // prAutoDetect: "on"/"off" → true/false
  if (kv["prAutoDetect"] === "on") result["prAutoDetect"] = true;
  else if (kv["prAutoDetect"] === "off") result["prAutoDetect"] = false;

  // runtimeHandle: parse JSON string → object
  if (kv["runtimeHandle"]) {
    try {
      result["runtimeHandle"] = JSON.parse(kv["runtimeHandle"]);
    } catch {
      result["runtimeHandle"] = kv["runtimeHandle"];
    }
  }

  // statePayload → lifecycle object
  if (kv["statePayload"]) {
    try {
      result["lifecycle"] = JSON.parse(kv["statePayload"]);
    } catch {
      // If statePayload is unparseable, leave it as-is for debugging
      result["statePayload"] = kv["statePayload"];
    }
  }
  // Drop "status" (computed on read) and "stateVersion" (inside lifecycle)

  // Port fields: string → number
  const portFields: Record<string, string> = {
    dashboardPort: "port",
    terminalWsPort: "terminalWsPort",
    directTerminalWsPort: "directTerminalWsPort",
  };
  const dashboard: Record<string, number> = {};
  for (const [kvKey, jsonKey] of Object.entries(portFields)) {
    if (kv[kvKey]) {
      const num = Number(kv[kvKey]);
      if (Number.isFinite(num)) dashboard[jsonKey] = num;
    }
  }
  if (Object.keys(dashboard).length > 0) result["dashboard"] = dashboard;

  // agentReport grouping
  const agentReport: Record<string, unknown> = {};
  if (kv["agentReportedState"]) agentReport["state"] = kv["agentReportedState"];
  if (kv["agentReportedAt"]) agentReport["at"] = kv["agentReportedAt"];
  if (kv["agentReportedNote"]) agentReport["note"] = kv["agentReportedNote"];
  if (Object.keys(agentReport).length > 0) result["agentReport"] = agentReport;

  // reportWatcher grouping
  const reportWatcher: Record<string, unknown> = {};
  if (kv["reportWatcherLastAuditedAt"]) reportWatcher["lastAuditedAt"] = kv["reportWatcherLastAuditedAt"];
  if (kv["reportWatcherActiveTrigger"]) reportWatcher["activeTrigger"] = kv["reportWatcherActiveTrigger"];
  if (kv["reportWatcherTriggerActivatedAt"]) reportWatcher["triggerActivatedAt"] = kv["reportWatcherTriggerActivatedAt"];
  if (kv["reportWatcherTriggerCount"]) {
    const num = Number(kv["reportWatcherTriggerCount"]);
    reportWatcher["triggerCount"] = Number.isFinite(num) ? num : kv["reportWatcherTriggerCount"];
  }
  if (Object.keys(reportWatcher).length > 0) result["reportWatcher"] = reportWatcher;

  // detecting fields — keep at top level to match runtime behavior.
  // The lifecycle manager reads/writes these as flat top-level fields
  // (session.metadata["detectingAttempts"], etc.), not from lifecycle.detecting.
  if (kv["lifecycleEvidence"]) result["lifecycleEvidence"] = kv["lifecycleEvidence"];
  if (kv["detectingAttempts"]) result["detectingAttempts"] = kv["detectingAttempts"];
  if (kv["detectingStartedAt"]) result["detectingStartedAt"] = kv["detectingStartedAt"];
  if (kv["detectingEvidenceHash"]) result["detectingEvidenceHash"] = kv["detectingEvidenceHash"];

  // Preserve unknown fields that weren't handled above.
  // This prevents data loss for custom or future metadata fields.
  const handledKeys = new Set([
    ...stringFields, "worktree", "prAutoDetect", "runtimeHandle",
    "statePayload", "stateVersion", "status",
    "dashboardPort", "terminalWsPort", "directTerminalWsPort",
    "agentReportedState", "agentReportedAt", "agentReportedNote",
    "reportWatcherLastAuditedAt", "reportWatcherActiveTrigger",
    "reportWatcherTriggerActivatedAt", "reportWatcherTriggerCount",
    "lifecycleEvidence", "detectingAttempts", "detectingStartedAt", "detectingEvidenceHash",
  ]);
  for (const [key, value] of Object.entries(kv)) {
    if (!handledKeys.has(key) && !(key in result)) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Detect if content is JSON or key=value format.
 */
function isJsonContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/**
 * Read and convert a metadata file — handles both old key=value and JSON.
 */
function readAndConvertMetadata(filePath: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return null;

    if (isJsonContent(content)) {
      return JSON.parse(content) as Record<string, unknown>;
    }
    return convertKeyValueToJson(content);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-project migration
// ---------------------------------------------------------------------------

interface ProjectMigrationResult {
  sessions: number;
  archives: number;
  worktrees: number;
  orchestratorExtracted: boolean;
}

function isOrchestratorSession(metadata: Record<string, unknown>, sessionId: string): boolean {
  if (metadata["role"] === "orchestrator") return true;
  return /[-_]orchestrator[-_]\d+$/.test(sessionId);
}

/**
 * Fix archive filenames: replace colons and dots in timestamps with compact format.
 * Old: ao-83_2026-04-20T14:30:52.000Z → New: ao-83_20260420T143052Z
 */
function fixArchiveFilename(filename: string): string {
  // Match: {sessionId}_{iso-timestamp-with-colons}
  const match = filename.match(/^(.+?)_(\d{4}-\d{2}-\d{2}T.+)$/);
  if (!match) return filename;

  const sessionPart = match[1];
  const timestampPart = match[2];

  try {
    let iso = timestampPart;
    // Legacy timestamps may have colons/dots replaced with dashes on some filesystems
    // e.g. "2026-04-20T14-30-52-000Z" → "2026-04-20T14:30:52.000Z"
    const sanitizedTime = iso.match(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
    if (sanitizedTime) {
      const datePart = iso.slice(0, iso.indexOf("T"));
      iso = `${datePart}T${sanitizedTime[1]}:${sanitizedTime[2]}:${sanitizedTime[3]}.${sanitizedTime[4]}Z`;
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return filename;
    return `${sessionPart}_${compactTimestamp(date)}.json`;
  } catch {
    return filename;
  }
}

function migrateProject(
  projectId: string,
  hashDirs: HashDirEntry[],
  aoBaseDir: string,
  dryRun: boolean,
  log: (message: string) => void,
): ProjectMigrationResult {
  const projectDir = join(aoBaseDir, "projects", projectId);
  const sessionsDir = join(projectDir, "sessions");
  const archiveDir = join(sessionsDir, "archive");
  const worktreesDir = join(projectDir, "worktrees");

  if (!dryRun) {
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    mkdirSync(worktreesDir, { recursive: true });
  }

  const result: ProjectMigrationResult = {
    sessions: 0,
    archives: 0,
    worktrees: 0,
    orchestratorExtracted: false,
  };

  // Collect all sessions across hash dirs, tracking best orchestrator
  const allSessions = new Map<string, { metadata: Record<string, unknown>; sourcePath: string }>();
  let bestOrchestrator: { id: string; metadata: Record<string, unknown>; createdAt: string } | null = null;

  for (const hashDir of hashDirs) {
    const oldSessionsDir = join(hashDir.path, "sessions");
    if (!existsSync(oldSessionsDir)) continue;

    for (const file of readdirSync(oldSessionsDir)) {
      if (file === "archive" || file.startsWith(".")) continue;
      const filePath = join(oldSessionsDir, file);
      try {
        if (!statSync(filePath).isFile()) continue;
      } catch {
        continue;
      }

      // Strip .json extension if present
      const sessionId = file.endsWith(".json") ? file.slice(0, -5) : file;
      const metadata = readAndConvertMetadata(filePath);
      if (!metadata) {
        log(`  Warning: could not read metadata for ${sessionId} in ${hashDir.path}`);
        continue;
      }

      // Handle duplicate session IDs across hash dirs
      const existing = allSessions.get(sessionId);
      if (existing) {
        const existingCreated = String(existing.metadata["createdAt"] ?? "");
        const newCreated = String(metadata["createdAt"] ?? "");
        if (newCreated > existingCreated) {
          // Archive the older one
          if (!dryRun) {
            const ts = compactTimestamp(new Date());
            const archivePath = join(archiveDir, `${sessionId}_${ts}.json`);
            writeFileSync(archivePath, JSON.stringify(existing.metadata, null, 2) + "\n");
          }
          result.archives++;
          allSessions.set(sessionId, { metadata, sourcePath: filePath });
        } else {
          // Archive the newer one (keep existing)
          if (!dryRun) {
            const ts = compactTimestamp(new Date());
            const archivePath = join(archiveDir, `${sessionId}_${ts}.json`);
            writeFileSync(archivePath, JSON.stringify(metadata, null, 2) + "\n");
          }
          result.archives++;
        }
      } else {
        allSessions.set(sessionId, { metadata, sourcePath: filePath });
      }
    }

    // Migrate archives
    const oldArchiveDir = join(oldSessionsDir, "archive");
    if (existsSync(oldArchiveDir)) {
      for (const file of readdirSync(oldArchiveDir)) {
        if (file.startsWith(".")) continue;
        const filePath = join(oldArchiveDir, file);
        try {
          if (!statSync(filePath).isFile()) continue;
        } catch {
          continue;
        }

        const metadata = readAndConvertMetadata(filePath);
        const fixedName = fixArchiveFilename(file.endsWith(".json") ? file : file);
        const destName = fixedName.endsWith(".json") ? fixedName : `${fixedName}.json`;
        const destPath = join(archiveDir, destName);

        if (!dryRun) {
          if (metadata) {
            writeFileSync(destPath, JSON.stringify(metadata, null, 2) + "\n");
          } else {
            // Can't parse — copy raw
            copyFileSync(filePath, destPath);
          }
        }
        result.archives++;
      }
    }

    // Migrate worktrees
    const oldWorktreesDir = join(hashDir.path, "worktrees");
    if (existsSync(oldWorktreesDir)) {
      for (const worktreeName of readdirSync(oldWorktreesDir)) {
        const srcWorktree = join(oldWorktreesDir, worktreeName);
        try {
          if (!statSync(srcWorktree).isDirectory()) continue;
        } catch {
          continue;
        }

        const destWorktree = join(worktreesDir, worktreeName);
        if (!existsSync(destWorktree) && !dryRun) {
          renameSync(srcWorktree, destWorktree);
        }
        result.worktrees++;
      }
    }
  }

  // Identify orchestrators and write sessions
  for (const [sessionId, { metadata }] of allSessions) {
    if (isOrchestratorSession(metadata, sessionId)) {
      const createdAt = String(metadata["createdAt"] ?? "");
      if (!bestOrchestrator || createdAt > bestOrchestrator.createdAt) {
        // Archive previous best orchestrator
        if (bestOrchestrator && !dryRun) {
          const ts = compactTimestamp(new Date());
          const archivePath = join(archiveDir, `${bestOrchestrator.id}_${ts}.json`);
          writeFileSync(archivePath, JSON.stringify(bestOrchestrator.metadata, null, 2) + "\n");
          result.archives++;
        }
        bestOrchestrator = { id: sessionId, metadata, createdAt };
      } else {
        // Archive this orchestrator
        if (!dryRun) {
          const ts = compactTimestamp(new Date());
          const archivePath = join(archiveDir, `${sessionId}_${ts}.json`);
          writeFileSync(archivePath, JSON.stringify(metadata, null, 2) + "\n");
        }
        result.archives++;
      }
    } else {
      // Worker session — update worktree path to new V2 location
      if (typeof metadata["worktree"] === "string" && metadata["worktree"]) {
        const worktreePath = metadata["worktree"];
        if (worktreePath.startsWith("/") || worktreePath.startsWith("~")) {
          metadata["worktree"] = join(worktreesDir, sessionId);
        }
      }

      if (!dryRun) {
        const destPath = join(sessionsDir, `${sessionId}.json`);
        writeFileSync(destPath, JSON.stringify(metadata, null, 2) + "\n");
      }
      result.sessions++;
    }
  }

  // Write orchestrator
  if (bestOrchestrator) {
    const orchMetadata = bestOrchestrator.metadata;
    // Orchestrators don't have worktrees
    delete orchMetadata["worktree"];
    delete orchMetadata["branch"];

    if (!dryRun) {
      const orchPath = join(projectDir, "orchestrator.json");
      writeFileSync(orchPath, JSON.stringify(orchMetadata, null, 2) + "\n");
    }
    result.orchestratorExtracted = true;
    log(`  Extracted orchestrator: ${bestOrchestrator.id}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Config update — strip storageKey
// ---------------------------------------------------------------------------

function stripStorageKeysFromConfig(configPath: string, dryRun: boolean, log: (message: string) => void): void {
  if (!existsSync(configPath)) return;

  const content = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(content) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") return;

  const projects = parsed["projects"] as Record<string, Record<string, unknown>> | undefined;
  if (!projects || typeof projects !== "object") return;

  let stripped = 0;
  for (const [, entry] of Object.entries(projects)) {
    if (entry && typeof entry === "object" && "storageKey" in entry) {
      delete entry["storageKey"];
      stripped++;
    }
  }

  if (stripped > 0) {
    log(`  Stripped storageKey from ${stripped} project(s) in config.`);
    if (!dryRun) {
      // Backup the config before modifying
      const backupPath = `${configPath}.pre-migration`;
      if (!existsSync(backupPath)) {
        writeFileSync(backupPath, content);
        log(`  Config backed up to ${basename(backupPath)}`);
      }
      writeFileSync(configPath, stringifyYaml(parsed, { indent: 2 }));
    }
  }
}

// ---------------------------------------------------------------------------
// Stray worktree detection
// ---------------------------------------------------------------------------

function moveStrayWorktrees(
  aoBaseDir: string,
  dryRun: boolean,
  log: (message: string) => void,
): number {
  const strayDir = join(homedir(), ".worktrees");
  if (!existsSync(strayDir)) return 0;

  let moved = 0;
  for (const name of readdirSync(strayDir)) {
    const srcPath = join(strayDir, name);
    try {
      if (!statSync(srcPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Try to match worktree to a project by checking if a matching session exists
    // under any project in the new layout
    const projectsDir = join(aoBaseDir, "projects");
    if (!existsSync(projectsDir)) continue;

    let matched = false;
    for (const projectId of readdirSync(projectsDir)) {
      const sessionsDir = join(projectsDir, projectId, "sessions");
      if (!existsSync(sessionsDir)) continue;

      // Check if there's a session matching this worktree name
      const sessionFile = join(sessionsDir, `${name}.json`);
      if (existsSync(sessionFile)) {
        const destPath = join(projectsDir, projectId, "worktrees", name);
        if (!existsSync(destPath)) {
          log(`  Moving stray worktree ${name} → projects/${projectId}/worktrees/`);
          if (!dryRun) {
            mkdirSync(join(projectsDir, projectId, "worktrees"), { recursive: true });
            renameSync(srcPath, destPath);
          }
          matched = true;
          moved++;
          break;
        }
      }
    }

    if (!matched) {
      log(`  Warning: stray worktree ${name} in ~/.worktrees/ has no matching session — left in place.`);
    }
  }

  return moved;
}

// ---------------------------------------------------------------------------
// Main migration entry point
// ---------------------------------------------------------------------------

export async function migrateStorage(options: MigrationOptions = {}): Promise<MigrationResult> {
  const aoBaseDir = options.aoBaseDir ?? join(homedir(), ".agent-orchestrator");
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? console.log;
  const globalConfigPath = options.globalConfigPath ??
    join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "agent-orchestrator", "config.yaml");

  // Use the actual global config path if it exists at the standard location
  const effectiveConfigPath = existsSync(globalConfigPath)
    ? globalConfigPath
    : existsSync(join(aoBaseDir, "config.yaml"))
      ? join(aoBaseDir, "config.yaml")
      : globalConfigPath;

  if (dryRun) {
    log("DRY RUN — no changes will be made.\n");
  }

  // Pre-flight: detect active sessions (include V2 prefix patterns from config)
  if (!options.force) {
    const knownPrefixes = extractProjectPrefixes(effectiveConfigPath);
    const activeSessions = await detectActiveSessions(knownPrefixes);
    if (activeSessions.length > 0) {
      throw new Error(
        `Found ${activeSessions.length} active AO tmux session(s): ${activeSessions.slice(0, 5).join(", ")}${activeSessions.length > 5 ? "..." : ""}. ` +
        `Kill active sessions first (ao session kill --all) or use --force to migrate anyway.`,
      );
    }
  }

  // Inventory hash directories (pass config path for bare-hash projectId lookup)
  const hashDirs = inventoryHashDirs(aoBaseDir, effectiveConfigPath);
  if (hashDirs.length === 0) {
    log("No legacy hash-based directories found. Nothing to migrate.");
    return { projects: 0, sessions: 0, archives: 0, worktrees: 0, emptyDirsDeleted: 0, strayWorktreesMoved: 0 };
  }

  log(`Found ${hashDirs.length} legacy director${hashDirs.length === 1 ? "y" : "ies"}.`);

  // Group by projectId
  const projectGroups = new Map<string, HashDirEntry[]>();
  for (const entry of hashDirs) {
    const group = projectGroups.get(entry.projectId) ?? [];
    group.push(entry);
    projectGroups.set(entry.projectId, group);
  }

  // Create projects/ directory
  if (!dryRun) {
    mkdirSync(join(aoBaseDir, "projects"), { recursive: true });
  }

  const totals: MigrationResult = {
    projects: 0,
    sessions: 0,
    archives: 0,
    worktrees: 0,
    emptyDirsDeleted: 0,
    strayWorktreesMoved: 0,
  };

  // Migrate each project
  for (const [projectId, dirs] of projectGroups) {
    const nonEmpty = dirs.filter((d) => !d.empty);
    if (nonEmpty.length === 0) {
      // All dirs are empty — just delete them
      for (const dir of dirs) {
        log(`  Deleting empty directory: ${basename(dir.path)}`);
        if (!dryRun) {
          rmSync(dir.path, { recursive: true, force: true });
        }
        totals.emptyDirsDeleted++;
      }
      continue;
    }

    log(`\nMigrating project: ${projectId} (${dirs.length} hash dir${dirs.length > 1 ? "s" : ""})`);
    const projectResult = migrateProject(projectId, dirs, aoBaseDir, dryRun, log);

    totals.projects++;
    totals.sessions += projectResult.sessions;
    totals.archives += projectResult.archives;
    totals.worktrees += projectResult.worktrees;

    // Rename old directories to .migrated
    for (const dir of dirs) {
      if (dir.empty) {
        log(`  Deleting empty directory: ${basename(dir.path)}`);
        if (!dryRun) {
          rmSync(dir.path, { recursive: true, force: true });
        }
        totals.emptyDirsDeleted++;
      } else {
        const migratedPath = `${dir.path}.migrated`;
        log(`  Renaming: ${basename(dir.path)} → ${basename(dir.path)}.migrated`);
        if (!dryRun) {
          renameSync(dir.path, migratedPath);
        }
      }
    }
  }

  // Move stray worktrees from ~/.worktrees/
  totals.strayWorktreesMoved = moveStrayWorktrees(aoBaseDir, dryRun, log);

  // Strip storageKey from config
  log("\nUpdating config...");
  stripStorageKeysFromConfig(effectiveConfigPath, dryRun, log);

  // Summary
  log("\n--- Migration Summary ---");
  log(`Migrated ${totals.projects} project${totals.projects !== 1 ? "s" : ""}, ` +
    `${totals.sessions} session${totals.sessions !== 1 ? "s" : ""}, ` +
    `${totals.archives} archive${totals.archives !== 1 ? "s" : ""}, ` +
    `${totals.worktrees} worktree${totals.worktrees !== 1 ? "s" : ""}.`);
  if (totals.strayWorktreesMoved > 0) {
    log(`Moved ${totals.strayWorktreesMoved} stray worktree${totals.strayWorktreesMoved !== 1 ? "s" : ""} from ~/.worktrees/.`);
  }
  if (totals.emptyDirsDeleted > 0) {
    log(`Deleted ${totals.emptyDirsDeleted} empty director${totals.emptyDirsDeleted !== 1 ? "ies" : "y"}.`);
  }
  log("Old directories renamed to *.migrated — verify and rm -rf when ready.");

  return totals;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export async function rollbackStorage(options: RollbackOptions = {}): Promise<void> {
  const aoBaseDir = options.aoBaseDir ?? join(homedir(), ".agent-orchestrator");
  const log = options.log ?? console.log;
  const globalConfigPath = options.globalConfigPath ??
    join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "agent-orchestrator", "config.yaml");

  const effectiveConfigPath = existsSync(globalConfigPath)
    ? globalConfigPath
    : existsSync(join(aoBaseDir, "config.yaml"))
      ? join(aoBaseDir, "config.yaml")
      : globalConfigPath;

  if (!existsSync(aoBaseDir)) {
    log("No AO base directory found. Nothing to rollback.");
    return;
  }

  // Find .migrated directories (both {hash}-{name}.migrated and {hash}.migrated)
  const migratedDirs: Array<{ path: string; hash: string; projectId: string }> = [];
  for (const name of readdirSync(aoBaseDir)) {
    const hashNameMatch = MIGRATED_DIR_PATTERN.exec(name);
    const bareHashMatch = BARE_MIGRATED_DIR_PATTERN.exec(name);
    if (!hashNameMatch && !bareHashMatch) continue;

    const dirPath = join(aoBaseDir, name);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    if (hashNameMatch) {
      migratedDirs.push({
        path: dirPath,
        hash: hashNameMatch[1],
        projectId: hashNameMatch[2],
      });
    } else if (bareHashMatch) {
      migratedDirs.push({
        path: dirPath,
        hash: bareHashMatch[1],
        projectId: bareHashMatch[1], // bare hash — storageKey restoral uses hash
      });
    }
  }

  if (migratedDirs.length === 0) {
    log("No .migrated directories found. Nothing to rollback.");
    return;
  }

  log(`Found ${migratedDirs.length} .migrated director${migratedDirs.length === 1 ? "y" : "ies"}.`);

  // Rename .migrated back to original
  for (const dir of migratedDirs) {
    const originalPath = dir.path.replace(/\.migrated$/, "");
    log(`  Restoring: ${basename(dir.path)} → ${basename(originalPath)}`);
    renameSync(dir.path, originalPath);
  }

  // Remove only the project subdirectories that correspond to .migrated dirs.
  // Do NOT delete the entire projects/ directory — it may contain sessions
  // created after migration that have no .migrated counterpart.
  const projectsDir = join(aoBaseDir, "projects");
  if (existsSync(projectsDir)) {
    const migratedProjectIds = new Set(migratedDirs.map((d) => d.projectId));
    for (const projectId of migratedProjectIds) {
      const projectDir = join(projectsDir, projectId);
      if (existsSync(projectDir)) {
        log(`  Removing migrated project directory: projects/${projectId}`);
        rmSync(projectDir, { recursive: true, force: true });
      }
    }
    // Remove projects/ only if it's now empty
    try {
      const remaining = readdirSync(projectsDir);
      if (remaining.length === 0) {
        rmSync(projectsDir, { recursive: true, force: true });
      } else {
        log(`  Note: projects/ retained — contains ${remaining.length} non-migrated project(s).`);
      }
    } catch {
      // Ignore
    }
  }

  // Re-add storageKey to config.
  // Use the original directory name as storageKey — this ensures
  // getProjectBaseDir(storageKey) finds the restored directory directly,
  // regardless of whether the config used bare hash or {hash}-{projectName}.
  if (existsSync(effectiveConfigPath)) {
    const content = readFileSync(effectiveConfigPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const projects = parsed["projects"] as Record<string, Record<string, unknown>> | undefined;
      if (projects && typeof projects === "object") {
        let restored = 0;
        for (const dir of migratedDirs) {
          const entry = projects[dir.projectId];
          if (entry && typeof entry === "object") {
            // storageKey = original directory name (e.g. "abcdef012345-myproject" or "abcdef012345")
            const originalDirName = basename(dir.path).replace(/\.migrated$/, "");
            entry["storageKey"] = originalDirName;
            restored++;
          }
        }
        if (restored > 0) {
          log(`  Restored storageKey for ${restored} project(s) in config.`);
          writeFileSync(effectiveConfigPath, stringifyYaml(parsed, { indent: 2 }));
        }
      }
    }
  }

  log("\nRollback complete. Old hash-based directories restored.");
}
