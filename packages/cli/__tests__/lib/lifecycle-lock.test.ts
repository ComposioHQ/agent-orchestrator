import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLifecycleLockPath,
  readLifecycleLock,
  releaseLifecycleLock,
  setProcessStartTimeReaderForTests,
  tryAcquireLifecycleLock,
} from "../../src/lib/lifecycle-lock.js";

let tmpDir: string;
let configPath: string;
let projectId: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-lifecycle-lock-${randomUUID()}`);
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  projectId = `test-${randomUUID()}`;
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(configPath, "projects: {}\n", "utf-8");
});

afterEach(() => {
  const lockPath = getLifecycleLockPath(configPath, projectId);
  rmSync(dirname(lockPath), { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
  setProcessStartTimeReaderForTests();
  vi.restoreAllMocks();
});

describe("lifecycle lock", () => {
  it("acquires and releases a new lock", () => {
    const acquired = tryAcquireLifecycleLock({
      configPath,
      projectId,
      pid: 1111,
      now: new Date("2026-02-26T01:02:03.000Z"),
    });

    expect(acquired.acquired).toBe(true);
    expect(acquired.lock).toBeDefined();
    expect(readLifecycleLock(acquired.lockPath)).toEqual({
      pid: 1111,
      projectId,
      startedAt: "2026-02-26T01:02:03.000Z",
    });

    const released = releaseLifecycleLock(acquired.lock!);
    expect(released).toBe(true);
    expect(existsSync(acquired.lockPath)).toBe(false);
  });

  it("does not acquire when an active PID already owns the lock", () => {
    const lockPath = getLifecycleLockPath(configPath, projectId);
    mkdirSync(dirname(lockPath), { recursive: true });
    const startedAt = new Date().toISOString();
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        projectId,
        startedAt,
      })}\n`,
      "utf-8",
    );

    const attempted = tryAcquireLifecycleLock({
      configPath,
      projectId,
      pid: 2222,
    });

    expect(attempted.acquired).toBe(false);
    expect(attempted.existingPid).toBe(process.pid);
    expect(readLifecycleLock(lockPath)?.pid).toBe(process.pid);
  });

  it("recovers lock when PID is reused by a newer process", () => {
    const lockPath = getLifecycleLockPath(configPath, projectId);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 50505,
        projectId,
        startedAt: "2026-02-26T00:00:00.000Z",
      })}\n`,
      "utf-8",
    );

    vi.spyOn(process, "kill").mockImplementation(
      ((pid: number, signal?: string | number) => {
        if (pid === 50505 && signal === 0) {
          return true;
        }
        return true;
      }) as typeof process.kill,
    );

    setProcessStartTimeReaderForTests(() => Date.parse("2026-02-27T00:00:00.000Z"));

    const attempted = tryAcquireLifecycleLock({
      configPath,
      projectId,
      pid: 60606,
      now: new Date("2026-02-27T00:00:10.000Z"),
    });

    expect(attempted.acquired).toBe(true);
    expect(attempted.staleRecovered).toBe(true);
    expect(readLifecycleLock(lockPath)).toEqual({
      pid: 60606,
      projectId,
      startedAt: "2026-02-27T00:00:10.000Z",
    });
  });

  it("recovers stale lock files and re-acquires ownership", () => {
    const lockPath = getLifecycleLockPath(configPath, projectId);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 40404,
        projectId,
        startedAt: "2026-02-26T00:00:00.000Z",
      })}\n`,
      "utf-8",
    );

    vi.spyOn(process, "kill").mockImplementation(
      ((pid: number, signal?: string | number) => {
        if (pid === 40404 && signal === 0) {
          const err = new Error("No such process") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      }) as typeof process.kill,
    );

    const attempted = tryAcquireLifecycleLock({
      configPath,
      projectId,
      pid: 3333,
      now: new Date("2026-02-26T03:03:03.000Z"),
    });

    expect(attempted.acquired).toBe(true);
    expect(attempted.staleRecovered).toBe(true);
    expect(readLifecycleLock(lockPath)).toEqual({
      pid: 3333,
      projectId,
      startedAt: "2026-02-26T03:03:03.000Z",
    });
  });

  it("refuses to release lock when caller is not the owner", () => {
    const acquired = tryAcquireLifecycleLock({
      configPath,
      projectId,
      pid: 5555,
    });
    expect(acquired.acquired).toBe(true);

    const released = releaseLifecycleLock({
      lockPath: acquired.lockPath,
      pid: 7777,
      projectId,
    });

    expect(released).toBe(false);
    expect(readLifecycleLock(acquired.lockPath)?.pid).toBe(5555);
  });
});
