import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

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
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`, { cause: err });
      }

      const until = Date.now() + 50;
      while (Date.now() < until) {
        // Busy wait to keep this sync API dependency-free.
      }
    }
  }

  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Ignore cleanup races.
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
