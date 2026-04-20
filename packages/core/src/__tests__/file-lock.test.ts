import { closeSync, mkdirSync, openSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLockSync } from "../file-lock.js";

describe("withFileLockSync", () => {
  let tempRoot: string;
  let lockPath: string;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `ao-file-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempRoot, { recursive: true });
    lockPath = join(tempRoot, "config.lock");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("reclaims stale lock files before running the critical section", () => {
    const fd = openSync(lockPath, "w");
    closeSync(fd);
    const staleTime = new Date(Date.now() - 120_000);
    utimesSync(lockPath, staleTime, staleTime);

    const value = withFileLockSync(lockPath, () => "ok", { staleMs: 1_000 });

    expect(value).toBe("ok");
  });

  it("times out when another fresh lock cannot be acquired", () => {
    const fd = openSync(lockPath, "w");

    try {
      expect(() =>
        withFileLockSync(lockPath, () => "never", { timeoutMs: 20, staleMs: 60_000 }),
      ).toThrow(/Timed out waiting for file lock/);
    } finally {
      closeSync(fd);
    }
  });
});
