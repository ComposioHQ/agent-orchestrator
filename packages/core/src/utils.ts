/**
 * Shared utility functions for agent-orchestrator plugins.
 */

import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { RuntimeHandle } from "./types.js";

const execFileAsync = promisify(execFile);

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

/**
 * Check if an agent process is running in the given runtime handle's context.
 *
 * For tmux runtimes: finds the pane TTY, then uses `ps` to check if the
 * named process is running on that TTY.
 *
 * For other runtimes: checks if the PID stored in handle.data is alive.
 *
 * This is shared infrastructure for all agent plugins — each plugin just
 * provides its `processName` (e.g. "claude", "aider", "codex", "opencode").
 */
export async function isAgentProcessRunning(
  handle: RuntimeHandle,
  processName: string,
): Promise<boolean> {
  try {
    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync(
        "tmux",
        ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
        { timeout: 30_000 },
      );
      const ttys = ttyOut
        .trim()
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      if (ttys.length === 0) return false;

      const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
        timeout: 30_000,
      });
      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      // Escape regex metacharacters in processName, then match as a word boundary
      const escaped = processName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const processRe = new RegExp(`(?:^|/)${escaped}(?:\\s|$)`);
      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        const args = cols.slice(2).join(" ");
        if (processRe.test(args)) {
          return true;
        }
      }
      return false;
    }

    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "EPERM") {
          return true;
        }
        return false;
      }
    }

    return false;
  } catch {
    return false;
  }
}
