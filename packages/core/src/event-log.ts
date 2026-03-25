/**
 * Event Log — append-only JSONL audit trail for orchestrator events.
 *
 * Writes one JSON record per line to a `.jsonl` file, capturing all state
 * transitions and reaction executions for post-hoc debugging and audit.
 *
 * Path convention: ~/.agent-orchestrator/{hash}-events.jsonl
 * Use `getEventLogPath(configPath)` from paths.ts to compute the path.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// =============================================================================
// TYPES
// =============================================================================

/** A single entry written to the event log. */
export interface EventLogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type (e.g. "ci.failing", "reaction.triggered") */
  type: string;
  /** Session ID this event relates to */
  sessionId: string;
  /** Project ID */
  projectId: string;
  /** Human-readable message */
  message?: string;
  /** Arbitrary structured data */
  data?: Record<string, unknown>;
}

/** Append-only audit log interface. */
export interface EventLog {
  /**
   * Append a single entry to the log.
   * Synchronous to avoid ordering issues under concurrent writes.
   */
  append(entry: EventLogEntry): void;

  /** No-op: JSONL files don't need explicit closing, but satisfies the interface. */
  close(): void;
}

// =============================================================================
// IMPLEMENTATIONS
// =============================================================================

/**
 * Create a real event log that writes to a JSONL file.
 * The parent directory is created automatically if it doesn't exist.
 */
export function createEventLog(logPath: string): EventLog {
  // Ensure parent directory exists (e.g. ~/.agent-orchestrator/)
  mkdirSync(dirname(logPath), { recursive: true });

  return {
    append(entry: EventLogEntry): void {
      const line = JSON.stringify(entry);
      try {
        appendFileSync(logPath, line + "\n", "utf-8");
      } catch {
        // Best-effort: don't crash the orchestrator if the log write fails
      }
    },

    close(): void {
      // Nothing to close for append-only file writes
    },
  };
}

/**
 * Create a no-op event log that discards all entries.
 * Useful in tests or when event logging is disabled.
 */
export function createNullEventLog(): EventLog {
  return {
    append(): void {},
    close(): void {},
  };
}
