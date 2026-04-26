/**
 * Tee a child process's stdout/stderr to BOTH the parent's terminal and a
 * rotated log file. Used so `ao start`'s dashboard subprocess doesn't leave
 * its output unpersisted (gap 3 in the observability issue).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Only stat the log file for rotation once this many bytes have been written. */
const ROTATION_CHECK_INTERVAL_BYTES = 64 * 1024;

function rotateIfNeeded(filePath: string, maxBytes: number): void {
  if (!existsSync(filePath)) return;
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  const rotated = `${filePath}.1`;
  try {
    if (existsSync(rotated)) unlinkSync(rotated);
    renameSync(filePath, rotated);
  } catch {
    // best-effort
  }
}

function prefixChunk(chunk: Buffer | string, label: string): Buffer {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
  const now = new Date().toISOString();
  const lines = text.split("\n");
  const trailingEmpty = lines[lines.length - 1] === "";
  const withPrefix = lines
    .slice(0, trailingEmpty ? -1 : undefined)
    .map((line) => `${now} [${label}] ${line}`);
  // Always terminate with "\n" so adjacent chunks never share a line in the
  // log file. A chunk without a trailing newline gets one; a chunk that
  // already ends with "\n" stays correct because `trailingEmpty` stripped
  // the empty sentinel before the join.
  const joined = withPrefix.join("\n") + "\n";
  return Buffer.from(joined, "utf-8");
}

export interface TeeOptions {
  /** Maximum bytes before rotating to `<file>.1`. Default 5 MB. */
  maxBytes?: number;
  /** When false, skip mirroring to process.stdout/stderr. Default true. */
  mirror?: boolean;
}

/**
 * Pipe the child's stdout/stderr into `logFilePath` (append, rotated) and,
 * by default, also to the parent's stdout/stderr so interactive use is
 * unchanged.
 *
 * The child must be spawned with `stdio: ["ignore"|"inherit", "pipe", "pipe"]`
 * (or equivalent) so stdout/stderr are readable streams.
 */
export function teeChildOutput(
  child: ChildProcess,
  logFilePath: string,
  options: TeeOptions = {},
): void {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const mirror = options.mirror !== false;

  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
  } catch {
    // If we cannot create the directory, skip file logging but still mirror.
    if (child.stdout && mirror) child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    if (child.stderr && mirror) child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    return;
  }

  // Throttle rotation checks: stat'ing the file on every chunk blocks the
  // event loop for high-throughput subprocesses (e.g. a dev server with HMR).
  // Check only once per 64 KB written, plus once before the very first write.
  let bytesSinceRotationCheck = ROTATION_CHECK_INTERVAL_BYTES;

  const writeToFile = (chunk: Buffer | string, label: string): void => {
    try {
      if (bytesSinceRotationCheck >= ROTATION_CHECK_INTERVAL_BYTES) {
        rotateIfNeeded(logFilePath, maxBytes);
        bytesSinceRotationCheck = 0;
      }
      const payload = prefixChunk(chunk, label);
      appendFileSync(logFilePath, payload);
      bytesSinceRotationCheck += payload.length;
    } catch {
      // Best-effort: don't break the child if disk write fails.
    }
  };

  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      if (mirror) process.stdout.write(chunk);
      writeToFile(chunk, "stdout");
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      if (mirror) process.stderr.write(chunk);
      writeToFile(chunk, "stderr");
    });
  }
}
