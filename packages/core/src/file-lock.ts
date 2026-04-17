import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Acquire an exclusive lock on `lockPath` by creating a lockfile with O_EXCL.
 * Blocks (retries) for up to `timeoutMs` before throwing. Stale locks older
 * than `staleMs` are forcibly removed so a crashed writer can't deadlock the
 * next invocation.
 *
 * Use for serializing read-modify-write on shared config files.
 */
export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  options: { timeoutMs?: number; staleMs?: number } = {},
): T {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 60_000;
  mkdirSync(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`Failed to acquire file lock: ${lockPath}`, { cause: err });
      }
      try {
        const info = statSync(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // Lock disappeared between EEXIST and stat — retry immediately.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`, { cause: err });
      }
      const until = Date.now() + 50;
      while (Date.now() < until) {
        // Busy wait — sync API has no sleep. 50ms is short enough to not burn CPU.
      }
    }
  }

  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed — ignore.
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
