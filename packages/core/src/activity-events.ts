/**
 * Activity event logging — write API.
 *
 * recordActivityEvent() is synchronous and best-effort: it never throws.
 * If the DB is unavailable or a write fails, the event is dropped and
 * droppedEventCount is incremented.
 *
 * droppedEventCount is process-local. Events dropped in other processes
 * (web server, lifecycle manager) are not reflected here.
 */

import { getDb } from "./events-db.js";

// Distinct names to avoid collision with types.ts EventType / EventSource.
export type ActivityEventSource = "lifecycle" | "session-manager" | "api" | "ui";

export type ActivityEventKind =
  | "session.spawned"
  | "session.spawn_failed"
  | "session.killed"
  | "session.cleanup"
  | "activity.transition"
  | "lifecycle.transition"
  | "ci.failing"
  | "review.pending";

export type ActivityEventLevel = "debug" | "info" | "warn" | "error";

export interface ActivityEventInput {
  projectId?: string;
  sessionId?: string;
  source: ActivityEventSource;
  kind: ActivityEventKind;
  level?: ActivityEventLevel;
  summary: string;
  data?: Record<string, unknown>;
}

export interface ActivityEvent {
  id: number;
  tsEpoch: number;
  ts: string;
  projectId: string | null;
  sessionId: string | null;
  source: string;
  kind: string;
  level: string;
  summary: string;
  data: string | null;
}

let _droppedEventCount = 0;

/** Number of events dropped due to DB errors in this process. */
export function droppedEventCount(): number {
  return _droppedEventCount;
}

// Patterns that indicate sensitive field names
const SENSITIVE_KEY_RE = /token|password|secret|authorization|cookie|api[-_]?key/i;

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return SENSITIVE_KEY_RE.test(value) ? "[redacted]" : value;
  }
  return value;
}

function sanitizeData(data: Record<string, unknown>): string | undefined {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    cleaned[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactValue(v);
  }

  let json: string;
  try {
    json = JSON.stringify(cleaned, (_key, val) => {
      // Prevent BigInt and circular reference throws
      if (typeof val === "bigint") return val.toString();
      return val;
    });
  } catch {
    return undefined;
  }

  // Reject if over 16 KB after sanitization
  if (json.length > 16 * 1024) {
    return json.slice(0, 16 * 1024);
  }
  return json;
}

function sanitizeSummary(summary: string): string {
  return summary.slice(0, 500);
}

/**
 * Record an activity event. Synchronous, best-effort — never throws.
 */
export function recordActivityEvent(event: ActivityEventInput): void {
  const db = getDb();
  if (!db) {
    _droppedEventCount++;
    return;
  }

  const now = Date.now();
  const ts = new Date(now).toISOString();
  const summary = sanitizeSummary(event.summary);
  const data = event.data ? sanitizeData(event.data) : undefined;

  try {
    db.prepare(
      `INSERT INTO activity_events
        (ts_epoch, ts, project_id, session_id, source, type, log_level, summary, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      now,
      ts,
      event.projectId ?? null,
      event.sessionId ?? null,
      event.source,
      event.kind,
      event.level ?? "info",
      summary,
      data ?? null,
    );
  } catch {
    _droppedEventCount++;
  }
}
