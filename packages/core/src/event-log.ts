/**
 * Event log — always-on, append-only JSONL stream for self-debug.
 *
 * One line per probe, transition, reaction, and API call that touched a
 * session. Correlation ids thread a single user-visible transition across
 * subsystems (lifecycle tick → reaction → API call → metadata write).
 *
 * Location: `{observabilityBaseDir}/events.jsonl` — written even when no
 * daemon is polling the project, so invocations like `ao session kill`
 * still leave a trail. Size-rotated to one `.1` rollover.
 *
 * Read via `readEventLog()` (filter by project, session, kind, since, limit)
 * or tail via `followEventLog()` (watch-based tail).
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getObservabilityBaseDir } from "./paths.js";
import type { OrchestratorConfig, SessionId } from "./types.js";

/**
 * Kinds of events written to the log. Keep this narrow — every new kind
 * requires wiring into the lifecycle manager and the CLI filter.
 */
export type EventLogKind =
  | "probe"
  | "transition"
  | "reaction"
  | "api"
  | "agent"
  | "notify"
  | "lifecycle"
  | "session";

export type EventLogLevel = "debug" | "info" | "warn" | "error";

export interface EventLogProbeDetail {
  /** "alive" | "dead" | "unknown" | "missing" | "exited" | "probe_failed" | "not_applicable" | etc. */
  state?: string;
  /** Reason token from lifecycle state machine, e.g. "process_running", "probe_error". */
  reason?: string;
  /** Optional: probe result failed but state not observable. */
  failed?: boolean;
}

export interface EventLogEntry {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Stable correlation id for cross-subsystem tracing. */
  correlationId: string;
  /** Category for filtering in the CLI. */
  kind: EventLogKind;
  /** Component that wrote the entry, e.g. "lifecycle-manager", "session-manager". */
  component: string;
  /** Human-readable operation, e.g. "lifecycle.transition", "scm.detect_pr". */
  operation: string;
  /** "info" | "warn" | "error". */
  level: EventLogLevel;
  /** Project id (when known). */
  projectId?: string;
  /** Session id (when the event belongs to a session). */
  sessionId?: SessionId;
  /** Short reason token (e.g. "process_missing"). */
  reason?: string;
  /** Optional: status transition metadata. */
  fromStatus?: string;
  toStatus?: string;
  /** Optional: per-probe detail. */
  runtimeProbe?: EventLogProbeDetail;
  processProbe?: EventLogProbeDetail;
  activityProbe?: EventLogProbeDetail;
  /** Optional: duration in milliseconds for the traced operation. */
  durationMs?: number;
  /** Free-form structured data — redacted/truncated by the caller. */
  data?: Record<string, unknown>;
}

export interface AppendEventInput {
  correlationId?: string;
  kind: EventLogKind;
  component: string;
  operation: string;
  level?: EventLogLevel;
  projectId?: string;
  sessionId?: SessionId;
  reason?: string;
  fromStatus?: string;
  toStatus?: string;
  runtimeProbe?: EventLogProbeDetail;
  processProbe?: EventLogProbeDetail;
  activityProbe?: EventLogProbeDetail;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface ReadEventLogOptions {
  /** Filter by project id. */
  projectId?: string;
  /** Filter by session id. */
  sessionId?: SessionId;
  /** Filter by event kinds (OR). */
  kinds?: EventLogKind[];
  /** Only return entries at or after this ISO timestamp. */
  sinceIso?: string;
  /** Only return entries at or after this millisecond epoch. */
  sinceEpochMs?: number;
  /** Cap output to the N most recent matching entries. */
  limit?: number;
  /** Filter by correlation id. */
  correlationId?: string;
  /** Include the rotated .1 file. Default: true. */
  includeRotated?: boolean;
}

/** Default 10 MB per file before rotation. Override with `AO_EVENT_LOG_MAX_BYTES`. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** Cap pathological values for data redaction. */
const MAX_STRING_LENGTH = 1024;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 4;
const REDACTED = "[redacted]";

const SENSITIVE_KEY_PATTERN = /token|secret|password|cookie|authorization|api[-_]?key|prompt|message|note|body/i;

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeString(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_STRING_LENGTH ? `${trimmed.slice(0, MAX_STRING_LENGTH)}…` : trimmed;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_OBJECT_KEYS).map((entry) => sanitize(entry, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    return Object.fromEntries(
      entries.map(([key, entry]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitize(entry, depth + 1),
      ]),
    );
  }
  return String(value);
}

function sanitizeData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  return sanitize(data) as Record<string, unknown>;
}

function maxBytes(): number {
  const raw = process.env["AO_EVENT_LOG_MAX_BYTES"];
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

/**
 * Return the absolute path of the event log for this config.
 * Safe to call even if the directory does not yet exist.
 */
export function getEventLogPath(config: OrchestratorConfig): string {
  return join(getObservabilityBaseDir(config.configPath), "events.jsonl");
}

export function getRotatedEventLogPath(config: OrchestratorConfig): string {
  return `${getEventLogPath(config)}.1`;
}

function ensureParent(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function rotateIfNeeded(filePath: string): void {
  const limit = maxBytes();
  if (!existsSync(filePath)) return;
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }
  if (size < limit) return;
  const rotated = `${filePath}.1`;
  try {
    if (existsSync(rotated)) unlinkSync(rotated);
    renameSync(filePath, rotated);
  } catch {
    // Best-effort: if rotation fails we keep appending to the oversized file.
  }
}

/**
 * Append a single event to the project-level log. Never throws — observability
 * writes must not break the caller.
 */
export function appendEvent(config: OrchestratorConfig, input: AppendEventInput): void {
  const entry: EventLogEntry = {
    ts: nowIso(),
    correlationId: input.correlationId ?? createEventCorrelationId(),
    kind: input.kind,
    component: input.component,
    operation: input.operation,
    level: input.level ?? "info",
    projectId: input.projectId,
    sessionId: input.sessionId,
    reason: input.reason ? sanitizeString(input.reason) : undefined,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    runtimeProbe: input.runtimeProbe,
    processProbe: input.processProbe,
    activityProbe: input.activityProbe,
    durationMs: input.durationMs,
    data: sanitizeData(input.data),
  };

  try {
    const filePath = getEventLogPath(config);
    ensureParent(filePath);
    rotateIfNeeded(filePath);
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Swallow. Diagnostics around observability failures go elsewhere.
  }
}

export function createEventCorrelationId(prefix = "ao"): string {
  return `${prefix}-${randomUUID()}`;
}

function parseLine(line: string): EventLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.ts === "string") {
      return parsed as EventLogEntry;
    }
    return null;
  } catch {
    return null;
  }
}

function matchesFilter(entry: EventLogEntry, opts: ReadEventLogOptions): boolean {
  if (opts.projectId && entry.projectId !== opts.projectId) return false;
  if (opts.sessionId && entry.sessionId !== opts.sessionId) return false;
  if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes(entry.kind)) return false;
  if (opts.correlationId && entry.correlationId !== opts.correlationId) return false;
  if (opts.sinceIso) {
    if (entry.ts < opts.sinceIso) return false;
  }
  if (typeof opts.sinceEpochMs === "number") {
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts) || ts < opts.sinceEpochMs) return false;
  }
  return true;
}

function readFileEntries(filePath: string): EventLogEntry[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const entries: EventLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const parsed = parseLine(line);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

/**
 * Read event log entries, in chronological order, filtered by the given
 * options. When `limit` is provided it is applied AFTER sort and filter so
 * that the returned N are the most recent matches.
 */
export function readEventLog(
  config: OrchestratorConfig,
  opts: ReadEventLogOptions = {},
): EventLogEntry[] {
  const includeRotated = opts.includeRotated !== false;
  const paths: string[] = [];
  if (includeRotated) paths.push(getRotatedEventLogPath(config));
  paths.push(getEventLogPath(config));

  const collected: EventLogEntry[] = [];
  for (const path of paths) {
    for (const entry of readFileEntries(path)) {
      if (matchesFilter(entry, opts)) {
        collected.push(entry);
      }
    }
  }

  collected.sort((a, b) => a.ts.localeCompare(b.ts));
  if (typeof opts.limit === "number" && opts.limit > 0 && collected.length > opts.limit) {
    return collected.slice(-opts.limit);
  }
  return collected;
}

export interface FollowEventLogHandle {
  stop(): void;
}

/**
 * Tail the event log: invoke `onEntry` for each new matching entry appended
 * to the file. The initial backlog (respecting `opts.limit`, default 50) is
 * emitted synchronously before switching to watch mode.
 */
export function followEventLog(
  config: OrchestratorConfig,
  onEntry: (entry: EventLogEntry) => void,
  opts: ReadEventLogOptions = {},
): FollowEventLogHandle {
  const filePath = getEventLogPath(config);
  ensureParent(filePath);
  const limit = typeof opts.limit === "number" ? opts.limit : 50;
  const includeRotated = opts.includeRotated !== false;

  // Snapshot the current file by capturing its size, then reading exactly
  // that many bytes. `offset` ends up at the exact byte position where the
  // snapshot ended, so the tail below starts where the backlog finished —
  // no race window, no duplication when a concurrent writer appends between
  // our stat and our read.
  let offset = 0;
  let snapshotText = "";
  try {
    if (existsSync(filePath)) {
      const size = statSync(filePath).size;
      const fd = openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(size);
        const read = readSync(fd, buf, 0, size, 0);
        offset = read;
        snapshotText = buf.subarray(0, read).toString("utf-8");
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    offset = 0;
    snapshotText = "";
  }

  const backlog: EventLogEntry[] = [];
  if (includeRotated) {
    for (const entry of readFileEntries(getRotatedEventLogPath(config))) {
      if (matchesFilter(entry, opts)) backlog.push(entry);
    }
  }
  for (const line of snapshotText.split("\n")) {
    const parsed = parseLine(line);
    if (parsed && matchesFilter(parsed, opts)) backlog.push(parsed);
  }
  backlog.sort((a, b) => a.ts.localeCompare(b.ts));
  const emitted = backlog.length > limit ? backlog.slice(-limit) : backlog;
  for (const entry of emitted) {
    onEntry(entry);
  }

  let carry = "";

  function drain(): void {
    if (!existsSync(filePath)) return;
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return;
    }
    // File was truncated / rotated. Reset to start.
    if (size < offset) {
      offset = 0;
      carry = "";
    }
    if (size <= offset) return;

    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      const read = readSync(fd, buf, 0, buf.length, offset);
      offset += read;
      const chunk = carry + buf.slice(0, read).toString("utf-8");
      const lines = chunk.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed && matchesFilter(parsed, opts)) {
          onEntry(parsed);
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  const fileName = basename(filePath);
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dirname(filePath), { persistent: true }, (_, name) => {
      if (!name || name === fileName) {
        drain();
      }
    });
  } catch {
    // fs.watch unavailable — fall back to poll
  }

  const pollTimer = setInterval(drain, 1000);
  // Unref so the tailer does not keep the event loop alive on its own
  if (typeof pollTimer.unref === "function") pollTimer.unref();

  return {
    stop(): void {
      clearInterval(pollTimer);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // Best-effort
        }
      }
    },
  };
}
