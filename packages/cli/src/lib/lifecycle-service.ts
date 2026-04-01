import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getProjectBaseDir, getGlobalDataDir, type OrchestratorConfig } from "@composio/ao-core";

const LIFECYCLE_PID_FILE = "lifecycle-worker.pid";
const LIFECYCLE_LOG_FILE = "lifecycle-worker.log";
const LIFECYCLE_ALL_PID_FILENAME = "lifecycle-all.pid";
const DEFAULT_START_TIMEOUT_MS = 5_000;

/** Get the PID file path for the poll-all lifecycle worker. */
export function getAllProjectsPidFile(): string {
  return join(getGlobalDataDir(), LIFECYCLE_ALL_PID_FILENAME);
}
const STOP_TIMEOUT_MS = 5_000;

export interface LifecycleWorkerStatus {
  running: boolean;
  pid: number | null;
  pidFile: string;
  logFile: string;
}

function getProjectBase(config: OrchestratorConfig, projectId: string): string {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  return getProjectBaseDir(config.configPath, project.path);
}

export function getLifecyclePidFile(config: OrchestratorConfig, projectId: string): string {
  return join(getProjectBase(config, projectId), LIFECYCLE_PID_FILE);
}

export function getLifecycleLogFile(config: OrchestratorConfig, projectId: string): string {
  return join(getProjectBase(config, projectId), LIFECYCLE_LOG_FILE);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;

  try {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writeLifecycleWorkerPid(
  config: OrchestratorConfig,
  projectId: string,
  pid: number,
): void {
  const pidFile = getLifecyclePidFile(config, projectId);
  mkdirSync(getProjectBase(config, projectId), { recursive: true });
  writeFileSync(pidFile, `${pid}\n`, "utf-8");
}

export function clearLifecycleWorkerPid(
  config: OrchestratorConfig,
  projectId: string,
  pid?: number,
): void {
  const pidFile = getLifecyclePidFile(config, projectId);
  if (!existsSync(pidFile)) return;

  if (pid !== undefined) {
    const currentPid = readPid(pidFile);
    if (currentPid !== null && currentPid !== pid) {
      return;
    }
  }

  try {
    unlinkSync(pidFile);
  } catch {
    // Best effort cleanup
  }
}

export function getLifecycleWorkerStatus(
  config: OrchestratorConfig,
  projectId: string,
): LifecycleWorkerStatus {
  const pidFile = getLifecyclePidFile(config, projectId);
  const logFile = getLifecycleLogFile(config, projectId);

  // Check per-project worker first
  const pid = readPid(pidFile);
  if (pid !== null && isProcessRunning(pid)) {
    return { running: true, pid, pidFile, logFile };
  }
  if (pid !== null) {
    clearLifecycleWorkerPid(config, projectId, pid);
  }

  // Also check poll-all worker — if running, it covers this project.
  // Report running=true but keep pid=null so callers don't kill the
  // shared poll-all worker when stopping a single project.
  const allPidFile = getAllProjectsPidFile();
  const allPid = readPid(allPidFile);
  if (allPid !== null && isProcessRunning(allPid)) {
    return { running: true, pid: null, pidFile, logFile };
  }

  return { running: false, pid: null, pidFile, logFile };
}

function resolveLifecycleWorkerLaunch(projectId?: string): { command: string; args: string[] } {
  const entry = process.argv[1];
  const workerArgs = projectId ? ["lifecycle-worker", projectId] : ["lifecycle-worker"];

  if (entry && /\.(?:c|m)?js$/i.test(entry)) {
    return {
      command: process.execPath,
      args: [entry, ...workerArgs],
    };
  }

  if (entry && /\.ts$/i.test(entry)) {
    return {
      command: "npx",
      args: ["tsx", entry, ...workerArgs],
    };
  }

  return {
    command: "ao",
    args: workerArgs,
  };
}

async function waitForLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
): Promise<LifecycleWorkerStatus> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = getLifecycleWorkerStatus(config, projectId);
    if (status.running) {
      return status;
    }
    await sleep(100);
  }

  return getLifecycleWorkerStatus(config, projectId);
}

export async function ensureLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
): Promise<LifecycleWorkerStatus & { started: boolean }> {
  const current = getLifecycleWorkerStatus(config, projectId);
  if (current.running) {
    return { ...current, started: false };
  }

  const baseDir = getProjectBase(config, projectId);
  const logFile = getLifecycleLogFile(config, projectId);
  mkdirSync(baseDir, { recursive: true });

  const stdoutFd = openSync(logFile, "a");
  const stderrFd = openSync(logFile, "a");

  try {
    const launch = resolveLifecycleWorkerLaunch(projectId);
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: {
        ...process.env,
        AO_LIFECYCLE_PROJECT: projectId,
        AO_CONFIG_PATH: config.configPath,
      },
    });

    child.unref();

    // Write PID from the parent immediately after spawn to close the TOCTOU
    // window: without this, a second concurrent `ensureLifecycleWorker` call
    // could pass the "not running" check before the child writes its own PID.
    if (child.pid) {
      writeLifecycleWorkerPid(config, projectId, child.pid);
    }
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  const status = await waitForLifecycleWorker(config, projectId);
  if (!status.running) {
    throw new Error(
      `Lifecycle worker failed to start for project ${projectId}. See ${status.logFile}`,
    );
  }

  return { ...status, started: true };
}

export async function stopLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
): Promise<boolean> {
  const status = getLifecycleWorkerStatus(config, projectId);
  if (!status.running || status.pid === null) {
    clearLifecycleWorkerPid(config, projectId);
    return false;
  }

  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    clearLifecycleWorkerPid(config, projectId, status.pid);
    return false;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessRunning(status.pid)) {
      clearLifecycleWorkerPid(config, projectId, status.pid);
      return true;
    }
    await sleep(100);
  }

  try {
    process.kill(status.pid, "SIGKILL");
  } catch {
    // Best effort hard stop
  }

  clearLifecycleWorkerPid(config, projectId, status.pid);
  return true;
}
