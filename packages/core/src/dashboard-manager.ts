/**
 * Dashboard process manager — programmatic control of the Next.js dev server.
 *
 * Provides `restartDashboard()` for use by the orchestrator agent, lifecycle
 * manager, or any code that needs to kill/clean/restart the dashboard without
 * going through the CLI.
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";

const execFileAsync = promisify(execFileCb);

export interface DashboardRestartOpts {
  /** Wipe .next cache before restarting. */
  clean?: boolean;
  /** Port the dashboard listens on. Default 3000. */
  port?: number;
  /** Path to the @composio/ao-web package directory. */
  webDir: string;
  /** Log directory for PID file and output logs. */
  logDir: string;
  /** AO_CONFIG_PATH to pass to the dashboard. */
  configPath?: string;
  /** Max ms to wait for old process to release the port. Default 5000. */
  killTimeoutMs?: number;
  /** Called with status messages (for logging/display). */
  onStatus?: (message: string) => void;
}

export interface DashboardRestartResult {
  /** PID of the newly spawned dashboard process, or null if spawn failed. */
  pid: number | null;
  /** Whether an existing process was killed. */
  killed: boolean;
  /** Whether .next cache was cleaned. */
  cleaned: boolean;
}

/** Find PID of a process listening on a TCP port via lsof. */
async function findPidOnPort(port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], {
      timeout: 5000,
    });
    const pid = parseInt(stdout.trim().split("\n")[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Read PID from dashboard.pid file, verify it's alive. */
export function readPidFile(logDir: string): number | null {
  const pidFile = join(logDir, "dashboard.pid");
  if (!existsSync(pidFile)) return null;

  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;
    process.kill(pid, 0); // test if alive
    return pid;
  } catch {
    // stale — clean up
    try { unlinkSync(pidFile); } catch { /* best effort */ }
    return null;
  }
}

/** Write PID to dashboard.pid. */
export function writePidFile(logDir: string, pid: number): void {
  writeFileSync(join(logDir, "dashboard.pid"), String(pid), "utf-8");
}

/** Remove dashboard.pid. */
export function removePidFile(logDir: string): void {
  try {
    const f = join(logDir, "dashboard.pid");
    if (existsSync(f)) unlinkSync(f);
  } catch { /* best effort */ }
}

/** Wait for a port to become free. */
async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await findPidOnPort(port);
    if (!pid) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Port ${port} still in use after ${timeoutMs}ms`);
}

/**
 * Kill the running dashboard, optionally clean .next, and spawn a new one.
 *
 * The new process is spawned detached with stdout/stderr going to log files
 * so it survives the caller exiting. Returns immediately after spawn — does
 * NOT wait for the server to be healthy (use `waitForHealthy` for that).
 */
export async function restartDashboard(opts: DashboardRestartOpts): Promise<DashboardRestartResult> {
  const port = opts.port ?? 3000;
  const killTimeout = opts.killTimeoutMs ?? 5000;
  const log = opts.onStatus ?? (() => {});

  let killed = false;
  let cleaned = false;

  // 1. Find and kill existing dashboard
  const filePid = readPidFile(opts.logDir);
  const portPid = await findPidOnPort(port);
  const targetPid = filePid ?? portPid;

  if (targetPid) {
    log(`Stopping dashboard (PID ${targetPid}) on port ${port}...`);
    try {
      process.kill(targetPid, "SIGTERM");
    } catch {
      // already exited
    }
    await waitForPortFree(port, killTimeout);
    removePidFile(opts.logDir);
    killed = true;
    log("Dashboard stopped.");
  }

  // 2. Clean .next cache if requested
  if (opts.clean) {
    const nextDir = resolve(opts.webDir, ".next");
    if (existsSync(nextDir)) {
      log("Cleaning .next cache...");
      rmSync(nextDir, { recursive: true, force: true });
      cleaned = true;
      log("Cache cleaned.");
    }
  }

  // 3. Spawn new dashboard (detached, logs to files)
  if (!existsSync(opts.logDir)) {
    mkdirSync(opts.logDir, { recursive: true });
  }

  const outFd = openSync(join(opts.logDir, "dashboard.out.log"), "a");
  const errFd = openSync(join(opts.logDir, "dashboard.err.log"), "a");

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env["PORT"] = String(port);
  if (opts.configPath) {
    env["AO_CONFIG_PATH"] = opts.configPath;
  }
  env["NEXT_PUBLIC_TERMINAL_PORT"] = env["TERMINAL_PORT"] ?? "14800";
  env["NEXT_PUBLIC_DIRECT_TERMINAL_PORT"] = env["DIRECT_TERMINAL_PORT"] ?? "14801";

  const child = spawn("npx", ["next", "dev", "-p", String(port)], {
    cwd: opts.webDir,
    stdio: ["ignore", outFd, errFd],
    detached: true,
    env,
  });

  // Close FDs in the parent — the child has its own copies via dup2
  closeSync(outFd);
  closeSync(errFd);

  child.unref();

  const pid = child.pid ?? null;
  if (pid) {
    writePidFile(opts.logDir, pid);
    log(`Dashboard started (PID ${pid}) on port ${port}.`);
  }

  return { pid, killed, cleaned };
}

/**
 * Wait for the dashboard to respond to HTTP requests.
 * Polls `http://localhost:{port}` until it gets a response or times out.
 */
export async function waitForHealthy(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://localhost:${port}`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok || res.status === 404) return true; // 404 is fine, server is responding
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Get the status of the dashboard process.
 */
export async function getDashboardStatus(
  logDir: string,
  port: number,
): Promise<{
  running: boolean;
  pid: number | null;
  source: "pid_file" | "port_scan" | null;
}> {
  const filePid = readPidFile(logDir);
  if (filePid) {
    return { running: true, pid: filePid, source: "pid_file" };
  }

  const portPid = await findPidOnPort(port);
  if (portPid) {
    return { running: true, pid: portPid, source: "port_scan" };
  }

  return { running: false, pid: null, source: null };
}

/**
 * Stop the dashboard without restarting.
 */
export async function stopDashboard(
  logDir: string,
  port: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const filePid = readPidFile(logDir);
  const portPid = await findPidOnPort(port);
  const targetPid = filePid ?? portPid;

  if (!targetPid) return false;

  try {
    process.kill(targetPid, "SIGTERM");
  } catch {
    // already dead
  }

  await waitForPortFree(port, timeoutMs);
  removePidFile(logDir);
  return true;
}
