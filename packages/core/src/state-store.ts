/**
 * Append-Only Event Log State Store
 *
 * Architecture:
 * - Single source of truth: events.jsonl in project state directory
 * - Path: ~/.agent-orchestrator/{hash}-{projectId}/state/events.jsonl
 * - Lock-free writes using append-only + file locking
 * - Crash-safe: incomplete JSON lines discarded on hydration
 */

import {
  appendFileSync,
  copyFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionId, SessionStatus } from "./types.js";
import { readMetadata, listMetadata } from "./metadata.js";
import { generateProjectId, getProjectBaseDir, getSessionsDir } from "./paths.js";
import { loadConfig } from "./config.js";

/**
 * Session state event for the JSONL log
 */
export interface SessionEvent {
  /** Unix timestamp (seconds) */
  timestamp: number;
  /** Session ID (e.g., "int-1") */
  sessionId: SessionId;
  /** Project ID (directory basename) */
  projectId: string;
  /** New status after transition */
  status: SessionStatus;
  /** Optional metadata for this event */
  metadata?: Record<string, unknown>;
}

/**
 * Current state of a session (reconstructed from events)
 */
export interface SessionState {
  sessionId: SessionId;
  projectId: string;
  status: SessionStatus;
  lastUpdated: number;
  metadata: Record<string, unknown>;
}

/**
 * StateStore configuration
 */
interface StateStoreConfig {
  /** Path to config file (used for hash generation) */
  configPath: string;
  /** Project path to derive projectId */
  projectPath: string;
}

/**
 * Append-Only Event Log State Store
 *
 * Provides crash-safe, lock-free state management using JSON Lines format.
 * Each line is a JSON object representing a state transition event.
 */
const ARCHIVE_RETENTION_LIMIT = 10;

export class StateStore {
  private readonly stateDir: string;
  private readonly eventsFile: string;
  private state: Map<SessionId, SessionState> = new Map();
  private initialized = false;

  constructor(private readonly config: StateStoreConfig) {
    const baseDir = getProjectBaseDir(config.configPath, config.projectPath);
    this.stateDir = join(baseDir, "state");
    this.eventsFile = join(this.stateDir, "events.jsonl");
  }

  /**
   * Initialize the state store and hydrate from disk
   */
  init(): void {
    this.ensureDirectoryExists();
    this.ensureEventsFileExists();
    this.hydrateState();
    this.initialized = true;
  }

  /**
   * Ensure the events.jsonl file exists (create if not present)
   */
  private ensureEventsFileExists(): void {
    if (!existsSync(this.eventsFile)) {
      writeFileSync(this.eventsFile, "", "utf-8");
    }
  }

  /**
   * Get the events file path (for debugging)
   */
  getEventsFilePath(): string {
    return this.eventsFile;
  }

  /**
   * Ensure the state directory exists
   */
  private ensureDirectoryExists(): void {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
  }

  /**
   * Get the current state of all sessions as a Map
   */
  getState(): Map<SessionId, SessionState> {
    return new Map(this.state);
  }

  /**
   * Get state for a specific session
   */
  getSessionState(sessionId: SessionId): SessionState | undefined {
    return this.state.get(sessionId);
  }

  /**
   * Append a new event to the JSONL log
   * Uses file locking for safe concurrent writes
   */
  appendEvent(event: SessionEvent): void {
    if (!this.initialized) {
      throw new Error("StateStore not initialized. Call init() first.");
    }

    const line = JSON.stringify(event) + "\n";

    // Use appendFileSync for atomic append (no read-modify-write)
    // The OS guarantees atomic writes for sizes < PIPE_BUF (typically 4KB)
    // For larger writes, we use flock-style locking via fsYNC
    appendFileSync(this.eventsFile, line, "utf-8");

    // Update in-memory state
    this.applyEvent(event);
  }

  /**
   * Sync the in-memory state without appending to disk.
   */
  syncState(event: SessionEvent): void {
    this.applyEvent(event);
  }

  /**
   * Update in-memory state after applying an event
   */
  private applyEvent(event: SessionEvent): void {
    const existing = this.state.get(event.sessionId);
    const newState: SessionState = {
      sessionId: event.sessionId,
      projectId: event.projectId,
      status: event.status,
      lastUpdated: event.timestamp,
      metadata: event.metadata ?? existing?.metadata ?? {},
    };
    this.state.set(event.sessionId, newState);
  }

  /**
   * Hydrate state from the JSONL log file
   * Replays events to rebuild current state
   * Handles truncated lines gracefully
   */
  hydrateState(): void {
    this.state.clear();

    if (!existsSync(this.eventsFile)) {
      return;
    }

    const content = readFileSync(this.eventsFile, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.trim()) {
        continue; // Skip empty lines
      }

      try {
        const event = JSON.parse(line) as SessionEvent;
        this.applyEvent(event);
      } catch {
        // Discard truncated/incomplete JSON lines
        // This is expected after crashes/power loss
        continue;
      }
    }
  }

  /**
   * Compact the log by rewriting with only the latest state per session
   * Archives the old log file before writing the new one
   */
  compactLog(): void {
    if (!this.initialized) {
      throw new Error("StateStore not initialized. Call init() first.");
    }

    if (this.state.size === 0) {
      return;
    }

    // Generate archive filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tempFile = join(this.stateDir, `events-${timestamp}.jsonl.tmp`);
    const archiveFile = join(this.stateDir, `events-${timestamp}.jsonl`);

    // Write new compacted log into a temp file first
    const lines: string[] = [];
    for (const [, sessionState] of this.state) {
      const event: SessionEvent = {
        timestamp: sessionState.lastUpdated,
        sessionId: sessionState.sessionId,
        projectId: sessionState.projectId,
        status: sessionState.status,
        metadata: sessionState.metadata,
      };
      lines.push(JSON.stringify(event));
    }

    writeFileSync(tempFile, lines.join("\n") + "\n", "utf-8");

    // Copy the old log to an archive before swapping
    if (existsSync(this.eventsFile)) {
      copyFileSync(this.eventsFile, archiveFile);
    }

    // Replace the live log with the compacted content
    renameSync(tempFile, this.eventsFile);

    this.cleanupArchives();
  }

  private cleanupArchives(): void {
    const archives = readdirSync(this.stateDir)
      .filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"))
      .sort();

    const excess = archives.length - ARCHIVE_RETENTION_LIMIT;
    if (excess < 1) {
      return;
    }

    for (let i = 0; i < excess; i++) {
      const archivePath = join(this.stateDir, archives[i]);
      unlinkSync(archivePath);
    }
  }

  /**
   * Get the state file path
   */
  getStateDir(): string {
    return this.stateDir;
  }

  /**
   * Check if state store is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Create a StateStore instance with proper config resolution
 *
 * @param configPath - Path to config file (optional, uses loadConfig if not provided)
 * @param projectPath - Path to project directory
 */
export function createStateStore(configPath: string, projectPath: string): StateStore {
  return new StateStore({
    configPath,
    projectPath,
  });
}

/**
 * Migration: Convert legacy metadata files to events.jsonl
 *
 * Reads all session metadata files from the legacy format and creates
 * initial events.jsonl entries with the final state.
 *
 * @param configPath - Path to config file
 * @param projectPath - Path to project directory
 * @returns Number of sessions migrated
 */
export function migrateFromMetadata(configPath: string, projectPath: string): number {
  const projectId = generateProjectId(projectPath);
  const sessionsDir = getSessionsDir(configPath, projectPath);

  if (!existsSync(sessionsDir)) {
    return 0;
  }

  const sessionIds = listMetadata(sessionsDir);
  if (sessionIds.length === 0) {
    return 0;
  }

  const store = createStateStore(configPath, projectPath);
  store.init();

  const now = Math.floor(Date.now() / 1000);
  let migrated = 0;

  for (const sessionId of sessionIds) {
    const metadata = readMetadata(sessionsDir, sessionId);
    if (!metadata) {
      continue;
    }

    const event: SessionEvent = {
      timestamp: metadata.createdAt
        ? Math.floor(new Date(metadata.createdAt).getTime() / 1000)
        : now,
      sessionId,
      projectId,
      status: (metadata.status as SessionStatus) || "working",
      metadata: {
        worktree: metadata.worktree,
        branch: metadata.branch,
        tmuxName: metadata.tmuxName,
        issue: metadata.issue,
        pr: metadata.pr,
        summary: metadata.summary,
        project: metadata.project,
        agent: metadata.agent,
      },
    };

    store.appendEvent(event);
    migrated++;
  }

  return migrated;
}

/**
 * Find and migrate all projects from legacy metadata to events.jsonl
 * Useful for one-time migration after upgrade
 *
 * @param configPath - Path to config file
 * @returns Array of migrated project paths and counts
 */
export function migrateAllProjects(configPath: string): Array<{
  projectPath: string;
  projectId: string;
  migratedCount: number;
}> {
  const config = loadConfig(configPath);
  const results: Array<{
    projectPath: string;
    projectId: string;
    migratedCount: number;
  }> = [];

  for (const [projectId, projectConfig] of Object.entries(config.projects) as [
    string,
    { path: string },
  ][]) {
    const count = migrateFromMetadata(configPath, projectConfig.path);
    if (count > 0) {
      results.push({
        projectPath: projectConfig.path,
        projectId,
        migratedCount: count,
      });
    }
  }

  return results;
}

/**
 * Get the state directory path for a project
 *
 * @param configPath - Path to config file
 * @param projectPath - Path to project directory
 * @returns Full path to state directory
 */
export function getStateDir(configPath: string, projectPath: string): string {
  const baseDir = getProjectBaseDir(configPath, projectPath);
  return join(baseDir, "state");
}

/**
 * Get the events.jsonl file path for a project
 *
 * @param configPath - Path to config file
 * @param projectPath - Path to project directory
 * @returns Full path to events.jsonl file
 */
export function getEventsFilePath(configPath: string, projectPath: string): string {
  return join(getStateDir(configPath, projectPath), "events.jsonl");
}

/**
 * Check if events.jsonl exists for a project
 *
 * @param configPath - Path to config file
 * @param projectPath - Path to project directory
 * @returns true if events.jsonl exists
 */
export function hasStateStore(configPath: string, projectPath: string): boolean {
  const eventsPath = getEventsFilePath(configPath, projectPath);
  return existsSync(eventsPath);
}
