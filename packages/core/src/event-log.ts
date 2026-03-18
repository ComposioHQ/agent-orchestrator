/**
 * Session Event Log — append-only JSONL event persistence.
 *
 * Each session gets an events.jsonl file at:
 *   <dataDir>/sessions/<id>/events.jsonl
 *
 * Events are one JSON object per line with a timestamp and event type.
 * This provides a persistent audit trail for session lifecycle — useful
 * for inspecting dead sessions after the fact.
 *
 * Optionally, terminal output can be captured periodically to:
 *   <dataDir>/sessions/<id>/terminal.log
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionId, SessionStatus } from "./types.js";

// =============================================================================
// EVENT TYPES
// =============================================================================

/** All session event type strings */
export type SessionEventType =
  | "session.created"
  | "session.started"
  | "session.status_changed"
  | "session.activity_changed"
  | "session.killed"
  | "session.terminated"
  | "session.restored"
  | "session.error"
  | "pr.created"
  | "pr.updated"
  | "pr.merged"
  | "pr.closed"
  | "ci.status_changed"
  | "review.decision_changed"
  | "terminal.captured";

/** A single event entry in the session event log */
export interface SessionEvent {
  /** ISO 8601 timestamp */
  ts: string;
  /** Event type */
  event: SessionEventType;
  /** Event-specific payload */
  data: Record<string, unknown>;
}

// =============================================================================
// DIRECTORY HELPERS
// =============================================================================

/** Validate sessionId to prevent path traversal (same pattern as metadata.ts) */
const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(sessionId: SessionId): void {
  if (!VALID_SESSION_ID.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

/**
 * Get the per-session directory for event logs and terminal captures.
 * Format: <sessionsDir>/<sessionId>/
 *
 * Note: sessionsDir is the project-level sessions directory
 * (e.g., ~/.agent-orchestrator/{hash}-{projectId}/sessions).
 * The event log lives in a subdirectory named after the session.
 */
export function getSessionEventDir(sessionsDir: string, sessionId: SessionId): string {
  validateSessionId(sessionId);
  return join(sessionsDir, sessionId + ".d");
}

/** Get the events.jsonl path for a session */
function eventsFilePath(sessionsDir: string, sessionId: SessionId): string {
  return join(getSessionEventDir(sessionsDir, sessionId), "events.jsonl");
}

/** Get the terminal.log path for a session */
export function terminalLogPath(sessionsDir: string, sessionId: SessionId): string {
  return join(getSessionEventDir(sessionsDir, sessionId), "terminal.log");
}

// =============================================================================
// WRITE
// =============================================================================

/**
 * Append a single event to the session's event log.
 *
 * Creates the directory and file if they don't exist.
 * Uses appendFileSync for simplicity — JSONL is append-friendly
 * and each line is a complete JSON object so partial writes don't
 * corrupt the log (worst case: a truncated trailing line).
 */
export function appendEvent(
  sessionsDir: string,
  sessionId: SessionId,
  event: SessionEventType,
  data: Record<string, unknown> = {},
): void {
  const dir = getSessionEventDir(sessionsDir, sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const entry: SessionEvent = {
    ts: new Date().toISOString(),
    event,
    data,
  };

  appendFileSync(eventsFilePath(sessionsDir, sessionId), JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Append a terminal capture snapshot to the session's terminal log.
 *
 * Each capture is prefixed with a timestamp header for readability.
 */
export function appendTerminalCapture(
  sessionsDir: string,
  sessionId: SessionId,
  output: string,
): void {
  if (!output.trim()) return;

  const dir = getSessionEventDir(sessionsDir, sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const header = `\n--- ${new Date().toISOString()} ---\n`;
  appendFileSync(terminalLogPath(sessionsDir, sessionId), header + output + "\n", "utf-8");

  // Also record a terminal.captured event in the event log
  appendEvent(sessionsDir, sessionId, "terminal.captured", {
    lines: output.split("\n").length,
  });
}

// =============================================================================
// READ
// =============================================================================

/**
 * Check if a session has any events without parsing the entire file.
 * Useful for cheap existence checks (e.g., API fallback project search).
 */
export function hasEvents(sessionsDir: string, sessionId: SessionId): boolean {
  return existsSync(eventsFilePath(sessionsDir, sessionId));
}

/**
 * Read events from a session's event log.
 *
 * Returns an array of parsed events, skipping any malformed lines.
 * Supports optional filtering by event type and pagination via limit/offset.
 *
 * Applies type filtering and limit during parsing to avoid reading
 * the entire file into memory when only a small subset is needed.
 */
export function readEvents(
  sessionsDir: string,
  sessionId: SessionId,
  options?: {
    /** Filter to specific event types */
    types?: SessionEventType[];
    /** Maximum number of events to return */
    limit?: number;
    /** Number of events to skip from the start */
    offset?: number;
  },
): SessionEvent[] {
  const filePath = eventsFilePath(sessionsDir, sessionId);
  if (!existsSync(filePath)) return [];

  // limit=0 explicitly means "return no events"
  if (options?.limit === 0) return [];

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());

  const typeSet =
    options?.types && options.types.length > 0 ? new Set(options.types) : null;
  const offset = options?.offset ?? 0;
  const limit = options?.limit;

  const events: SessionEvent[] = [];
  let matched = 0; // count of events that pass the type filter (for offset tracking)
  for (const line of lines) {
    // Early exit: collected enough events
    if (limit !== undefined && limit > 0 && events.length >= limit) break;

    try {
      const parsed = JSON.parse(line) as SessionEvent;
      if (!parsed.ts || !parsed.event) continue;

      // Apply type filter during parsing
      if (typeSet && !typeSet.has(parsed.event)) continue;

      // Apply offset
      if (matched < offset) {
        matched++;
        continue;
      }
      matched++;

      // Ensure data is always a valid object to prevent downstream TypeError
      if (!parsed.data || typeof parsed.data !== "object") {
        parsed.data = {};
      }
      events.push(parsed);
    } catch {
      // Skip malformed lines — append-only logs may have a truncated trailing line
    }
  }

  return events;
}

/**
 * Read the terminal log for a session.
 * Returns the raw terminal log content, or null if no log exists.
 */
export function readTerminalLog(sessionsDir: string, sessionId: SessionId): string | null {
  const filePath = terminalLogPath(sessionsDir, sessionId);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

// =============================================================================
// CONVENIENCE HELPERS
// =============================================================================

/** Log a session creation event */
export function logSessionCreated(
  sessionsDir: string,
  sessionId: SessionId,
  data: {
    projectId: string;
    branch: string;
    workspacePath: string;
    agent: string;
    issueId?: string;
  },
): void {
  appendEvent(sessionsDir, sessionId, "session.created", data);
}

/** Log agent process started */
export function logSessionStarted(
  sessionsDir: string,
  sessionId: SessionId,
  data: {
    runtimeId: string;
    runtimeName: string;
    launchCommand?: string;
  },
): void {
  appendEvent(sessionsDir, sessionId, "session.started", data);
}

/** Log a status change */
export function logStatusChanged(
  sessionsDir: string,
  sessionId: SessionId,
  data: {
    from: SessionStatus;
    to: SessionStatus;
  },
): void {
  appendEvent(sessionsDir, sessionId, "session.status_changed", data);
}

/** Log session killed/terminated */
export function logSessionKilled(
  sessionsDir: string,
  sessionId: SessionId,
  data: {
    reason?: string;
    exitCode?: number;
  } = {},
): void {
  appendEvent(sessionsDir, sessionId, "session.killed", data);
}

/** Log session restored */
export function logSessionRestored(
  sessionsDir: string,
  sessionId: SessionId,
  data: {
    previousStatus?: string;
    runtimeId?: string;
  } = {},
): void {
  appendEvent(sessionsDir, sessionId, "session.restored", data);
}

/** Log session error */
export function logSessionError(
  sessionsDir: string,
  sessionId: SessionId,
  data: {
    error: string;
    context?: string;
  },
): void {
  appendEvent(sessionsDir, sessionId, "session.error", data);
}
