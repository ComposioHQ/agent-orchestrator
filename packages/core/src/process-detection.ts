/**
 * Shared process-detection utilities for agent plugins.
 *
 * Consolidates the duplicated "is the agent process still alive?" logic that
 * was previously copy-pasted across all four agent plugins (codex, claude-code,
 * opencode, aider). Every plugin now delegates to `isAgentProcessRunning`,
 * which handles both tmux-based TTY lookup and direct PID checking, with a
 * shared `ps` output cache so that listing N sessions does not spawn N
 * concurrent `ps` processes.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeHandle } from "./types.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// ps output cache
// =============================================================================

/**
 * TTL cache for `ps -eo pid,tty,args` output. Without this, listing N sessions
 * would spawn N concurrent `ps` processes, each taking 30+ seconds on machines
 * with many processes. The cache ensures `ps` is called at most once per TTL
 * window regardless of how many sessions are being enriched.
 */
let psCache: { output: string; timestamp: number; promise?: Promise<string> } | null = null;
const DEFAULT_PS_CACHE_TTL_MS = 5_000;
let psCacheTtlMs = DEFAULT_PS_CACHE_TTL_MS;

/** Reset the ps cache. Exported for testing. */
export function resetPsCache(): void {
  psCache = null;
}

/**
 * Override the ps cache TTL. Exported for testing only.
 * Pass `undefined` to restore the default.
 */
export function setPsCacheTtlMs(ttl: number | undefined): void {
  psCacheTtlMs = ttl ?? DEFAULT_PS_CACHE_TTL_MS;
}

/** Escape special regex metacharacters in a literal string. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getCachedProcessList(): Promise<string> {
  const now = Date.now();
  if (psCache && now - psCache.timestamp < psCacheTtlMs) {
    if (psCache.promise) return psCache.promise;
    return psCache.output;
  }

  // Cache miss or expired — start a single `ps` call and share the promise.
  // Guard both callbacks so they only update psCache if it still belongs to
  // this request — a newer request may have replaced it while we were waiting.
  const promise = execFileAsync("ps", ["-eo", "pid,tty,args"], {
    timeout: 5_000,
  }).then(({ stdout }) => {
    if (psCache?.promise === promise) {
      psCache = { output: stdout, timestamp: Date.now() };
    }
    return stdout;
  });

  // Store the in-flight promise so concurrent callers share it
  psCache = { output: "", timestamp: now, promise };

  try {
    return await promise;
  } catch {
    // On failure, clear cache so the next caller retries — but only if
    // psCache still points to this request (avoid clobbering a newer entry)
    if (psCache?.promise === promise) {
      psCache = null;
    }
    return "";
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Check whether a process whose command-line matches `processName` is running
 * inside the given runtime handle's context.
 *
 * For **tmux** runtimes the function resolves the pane TTYs and scans `ps`
 * output for a matching process on any of those TTYs.
 *
 * For **process** (or other) runtimes it falls back to checking whether the PID
 * stored in `handle.data["pid"]` is still alive via `process.kill(pid, 0)`.
 *
 * @param handle      - The runtime handle returned by `runtime.create()`.
 * @param processName - The bare process name to match (e.g. `"codex"`, `"claude"`, `"aider"`).
 *                      Internally wrapped in `(?:^|\/)name(?:\s|$)` to avoid false positives.
 * @returns `true` if the agent process appears to be running, `false` otherwise.
 */
export async function isAgentProcessRunning(
  handle: RuntimeHandle,
  processName: string,
): Promise<boolean> {
  try {
    // CASE 1: tmux runtime — resolve pane TTYs, scan ps output
    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync(
        "tmux",
        ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
        { timeout: 5_000 },
      );
      const ttys = ttyOut
        .trim()
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      if (ttys.length === 0) return false;

      const psOut = await getCachedProcessList();
      if (!psOut) return false;

      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      const processRe = new RegExp(`(?:^|\\/)${escapeRegExp(processName)}(?:\\s|$)`);
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

    // CASE 2: process runtime — check if stored PID is still alive
    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // Signal 0 = existence check
        return true;
      } catch (err: unknown) {
        // EPERM means the process exists but we lack permission to signal it
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

/**
 * Find the PID of an agent process running in the given runtime handle's context.
 *
 * Similar to `isAgentProcessRunning` but returns the PID (for tmux) or the
 * stored PID (for process runtimes) instead of a boolean.
 *
 * @param handle      - The runtime handle returned by `runtime.create()`.
 * @param processName - The bare process name to match.
 * @returns The PID if found, or `null` otherwise.
 */
export async function findAgentProcess(
  handle: RuntimeHandle,
  processName: string,
): Promise<number | null> {
  try {
    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync(
        "tmux",
        ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
        { timeout: 5_000 },
      );
      const ttys = ttyOut
        .trim()
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      if (ttys.length === 0) return null;

      const psOut = await getCachedProcessList();
      if (!psOut) return null;

      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      const processRe = new RegExp(`(?:^|\\/)${escapeRegExp(processName)}(?:\\s|$)`);
      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        const args = cols.slice(2).join(" ");
        if (processRe.test(args)) {
          return parseInt(cols[0] ?? "0", 10);
        }
      }
      return null;
    }

    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return pid;
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "EPERM") {
          return pid;
        }
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}
