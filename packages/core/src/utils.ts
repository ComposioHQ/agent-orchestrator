/**
 * Shared utility functions for agent-orchestrator plugins.
 */

import { open, stat } from "node:fs/promises";

/**
 * POSIX-safe shell escaping: wraps value in single quotes,
 * escaping any embedded single quotes as '\\'' .
 *
 * Safe for use in both `sh -c` and `execFile` contexts.
 */
export function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Escape a string for safe interpolation inside AppleScript double-quoted strings.
 * Handles backslashes and double quotes which would otherwise break or inject.
 */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Validate that a URL starts with http:// or https://.
 * Throws with a descriptive error including the plugin label if invalid.
 */
export function validateUrl(url: string, label: string): void {
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error(`[${label}] Invalid url: must be http(s), got "${url}"`);
  }
}

/**
 * Compute a percentile value from a pre-sorted array of numbers.
 * Returns 0 for empty arrays.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Normalize an API route path by replacing dynamic segments with `:id` placeholders.
 * e.g. `/api/sessions/abc123` → `/api/sessions/:id`
 */
export function normalizeRoutePath(path: string): string {
  return path
    .replace(/\/sessions\/[^/]+/g, "/sessions/:id")
    .replace(/\/prs\/[^/]+/g, "/prs/:id");
}

/**
 * Read the last line from a file by reading backwards from the end.
 * Pure Node.js — no external binaries. Handles any file size.
 */
async function readLastLine(filePath: string): Promise<string | null> {
  const CHUNK = 4096;
  const fh = await open(filePath, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return null;

    // Read backwards in chunks, accumulating raw buffers to avoid
    // corrupting multi-byte UTF-8 characters at chunk boundaries.
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let pos = size;

    while (pos > 0) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const chunk = Buffer.alloc(readSize);
      await fh.read(chunk, 0, readSize, pos);
      chunks.unshift(chunk);
      totalBytes += readSize;

      // Convert all accumulated bytes to string at once (safe for multi-byte)
      const tail = Buffer.concat(chunks, totalBytes).toString("utf-8");

      // Find the last non-empty line
      const lines = tail.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line) {
          // If i > 0, we have a complete line (there's a newline before it)
          // If i === 0 and pos === 0, we've read the whole file — line is complete
          // If i === 0 and pos > 0, the line may be truncated — keep reading
          if (i > 0 || pos === 0) return line;
        }
      }
    }

    const tail = Buffer.concat(chunks, totalBytes).toString("utf-8");
    return tail.trim() || null;
  } finally {
    await fh.close();
  }
}

/**
 * Read the last entry from a JSONL file.
 * Reads backwards from end of file — pure Node.js, no external binaries.
 *
 * @param filePath - Path to the JSONL file
 * @returns Object containing the last entry's type and file mtime, or null if empty/invalid
 */
export async function readLastJsonlEntry(
  filePath: string,
): Promise<{ lastType: string | null; modifiedAt: Date } | null> {
  try {
    const [line, fileStat] = await Promise.all([readLastLine(filePath), stat(filePath)]);


    if (!line) return null;

    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const lastType = typeof obj.type === "string" ? obj.type : null;
      return { lastType, modifiedAt: fileStat.mtime };
    }

    return { lastType: null, modifiedAt: fileStat.mtime };
  } catch {
    return null;
  }
}
