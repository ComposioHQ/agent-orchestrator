import * as childProcess from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome, generateConfigHash } from "@composio/ao-core";

export const LIFECYCLE_LOCK_FILENAME = "lifecycle.lock";

export interface LifecycleLockData {
  pid: number;
  projectId: string;
  startedAt: string;
}

export interface AcquiredLifecycleLock {
  lockPath: string;
  pid: number;
  projectId: string;
}

export interface LifecycleLockAttempt {
  acquired: boolean;
  lockPath: string;
  existingPid?: number;
  staleRecovered?: boolean;
  lock?: AcquiredLifecycleLock;
}

export interface AcquireLifecycleLockOptions {
  configPath: string;
  projectId: string;
  pid?: number;
  now?: Date;
}

// If PID was recycled, the new process start time will be much later than lock startedAt.
const PID_REUSE_GRACE_MS = 30_000;

type ProcessStartTimeReader = (pid: number) => number | null;

/** Resolve lifecycle lock path for a project. */
export function getLifecycleLockPath(configPath: string, projectId: string): string {
  const hash = generateConfigHash(configPath);
  return join(expandHome("~/.agent-orchestrator"), `${hash}-${projectId}`, LIFECYCLE_LOCK_FILENAME);
}

/** Parse lifecycle lock JSON payload defensively. */
export function parseLifecycleLock(raw: string): LifecycleLockData | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LifecycleLockData>;
    const pid = parsed.pid;
    const projectId = parsed.projectId;
    const startedAt = parsed.startedAt;
    if (
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof projectId !== "string" ||
      projectId.length === 0 ||
      typeof startedAt !== "string" ||
      startedAt.length === 0
    ) {
      return null;
    }
    return { pid, projectId, startedAt };
  } catch {
    return null;
  }
}

/** Read and parse lifecycle lock data. */
export function readLifecycleLock(lockPath: string): LifecycleLockData | null {
  try {
    const raw = readFileSync(lockPath, "utf-8");
    return parseLifecycleLock(raw);
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

function defaultProcessStartTimeReader(pid: number): number | null {
  try {
    const startedAtRaw = childProcess
      .execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
    if (!startedAtRaw) return null;
    const parsed = Date.parse(startedAtRaw.replace(/\s+/g, " ").trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

let processStartTimeReader: ProcessStartTimeReader = defaultProcessStartTimeReader;

/**
 * Test hook: override process start time reader.
 * Pass undefined to restore default behavior.
 */
export function setProcessStartTimeReaderForTests(reader?: ProcessStartTimeReader): void {
  processStartTimeReader = reader ?? defaultProcessStartTimeReader;
}

function getProcessStartTimeMs(pid: number): number | null {
  return processStartTimeReader(pid);
}

function isLockOwnerProcessAlive(lockData: LifecycleLockData): boolean {
  if (!isProcessAlive(lockData.pid)) return false;

  const lockStartedMs = Date.parse(lockData.startedAt);
  if (!Number.isFinite(lockStartedMs)) return true;

  const processStartedMs = getProcessStartTimeMs(lockData.pid);
  if (processStartedMs === null) return true;

  return processStartedMs - lockStartedMs <= PID_REUSE_GRACE_MS;
}

function writeLockFile(
  lockPath: string,
  payload: LifecycleLockData,
): { acquired: boolean; lock?: AcquiredLifecycleLock } {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, { flag: "wx" });
  return {
    acquired: true,
    lock: {
      lockPath,
      pid: payload.pid,
      projectId: payload.projectId,
    },
  };
}

/** Acquire per-project lifecycle singleton lock, recovering stale locks. */
export function tryAcquireLifecycleLock(options: AcquireLifecycleLockOptions): LifecycleLockAttempt {
  const lockPath = getLifecycleLockPath(options.configPath, options.projectId);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? new Date();
  const payload: LifecycleLockData = {
    pid,
    projectId: options.projectId,
    startedAt: now.toISOString(),
  };

  try {
    const created = writeLockFile(lockPath, payload);
    return { lockPath, acquired: created.acquired, lock: created.lock };
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code !== "EEXIST") {
      return { lockPath, acquired: false };
    }
  }

  const current = readLifecycleLock(lockPath);
  if (current && isLockOwnerProcessAlive(current)) {
    return {
      lockPath,
      acquired: false,
      existingPid: current.pid,
    };
  }

  // Existing lock is stale (dead PID or malformed file) — recover.
  try {
    unlinkSync(lockPath);
  } catch {
    return {
      lockPath,
      acquired: false,
      existingPid: current?.pid,
    };
  }

  try {
    const recreated = writeLockFile(lockPath, payload);
    return {
      lockPath,
      acquired: recreated.acquired,
      staleRecovered: true,
      lock: recreated.lock,
    };
  } catch {
    const after = readLifecycleLock(lockPath);
    return {
      lockPath,
      acquired: false,
      existingPid: after?.pid,
      staleRecovered: true,
    };
  }
}

/** Release lock only when owned by the caller lock handle. */
export function releaseLifecycleLock(lock: AcquiredLifecycleLock): boolean {
  const current = readLifecycleLock(lock.lockPath);
  if (!current) return false;
  if (current.pid !== lock.pid || current.projectId !== lock.projectId) {
    return false;
  }

  try {
    unlinkSync(lock.lockPath);
    return true;
  } catch {
    return false;
  }
}
