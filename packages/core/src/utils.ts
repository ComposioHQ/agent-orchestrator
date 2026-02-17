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
 * Read the last line from a file by reading backwards from the end.
 * Pure Node.js — no external binaries. Handles any file size.
 */
async function readLastLine(filePath: string): Promise<string | null> {
  const CHUNK = 4096;
  const fh = await open(filePath, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return null;

    // Read backwards in chunks, accumulating bytes until we find a newline
    const buf = Buffer.alloc(Math.min(CHUNK, size));
    let tail = "";
    let pos = size;

    while (pos > 0) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      await fh.read(buf, 0, readSize, pos);
      tail = buf.toString("utf-8", 0, readSize) + tail;

      // Find the last non-empty line
      const lines = tail.split("\n");
      // Walk from end to find a non-empty line
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
