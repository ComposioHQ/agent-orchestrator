/**
 * JSONL log writer with size-based rotation.
 *
 * Writes structured log entries to .jsonl files with automatic rotation
 * when file size exceeds the configured limit. Crash-safe via appendFileSync.
 */

import { appendFileSync, statSync, renameSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { LogEntry, EventLogger } from "./types.js";

export interface LogWriterOptions {
  filePath: string;
  maxSizeBytes?: number;
  maxBackups?: number;
}

const DEFAULT_MAX_SIZE = 50 * 1024 * 1024; // 50MB
const DEFAULT_MAX_BACKUPS = 5;

export class LogWriter implements EventLogger {
  private readonly filePath: string;
  private readonly maxSizeBytes: number;
  private readonly maxBackups: number;
  private closed = false;

  constructor(opts: LogWriterOptions) {
    this.filePath = opts.filePath;
    this.maxSizeBytes = opts.maxSizeBytes ?? DEFAULT_MAX_SIZE;
    this.maxBackups = opts.maxBackups ?? DEFAULT_MAX_BACKUPS;

    // Ensure directory exists
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Append a structured log entry. */
  append(entry: LogEntry): void {
    if (this.closed) return;
    this.rotateIfNeeded();
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Write failed — best effort, don't crash the caller
    }
  }

  /** Convenience: create and append a LogEntry from a raw line. */
  appendLine(
    line: string,
    level: LogEntry["level"],
    source: LogEntry["source"],
    sessionId: string | null = null,
  ): void {
    this.append({
      ts: new Date().toISOString(),
      level,
      source,
      sessionId,
      message: line,
    });
  }

  /** Close the writer. Further appends are silently ignored. */
  close(): void {
    this.closed = true;
  }

  /** Check file size and rotate if needed. */
  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      // File doesn't exist yet — no rotation needed
      return;
    }

    if (size < this.maxSizeBytes) return;

    // Rotate: .jsonl -> .1.jsonl -> .2.jsonl -> ... -> .N.jsonl (deleted)
    const base = this.filePath.replace(/\.jsonl$/, "");
    const ext = ".jsonl";

    // Delete the oldest backup if it exists
    const oldestPath = `${base}.${this.maxBackups}${ext}`;
    try {
      if (existsSync(oldestPath)) {
        unlinkSync(oldestPath);
      }
    } catch {
      // best effort
    }

    // Shift existing backups: N-1 -> N, N-2 -> N-1, ..., 1 -> 2
    for (let i = this.maxBackups - 1; i >= 1; i--) {
      const from = `${base}.${i}${ext}`;
      const to = `${base}.${i + 1}${ext}`;
      try {
        if (existsSync(from)) {
          renameSync(from, to);
        }
      } catch {
        // best effort
      }
    }

    // Rename current file to .1.jsonl
    try {
      renameSync(this.filePath, `${base}.1${ext}`);
    } catch {
      // best effort
    }
  }
}
