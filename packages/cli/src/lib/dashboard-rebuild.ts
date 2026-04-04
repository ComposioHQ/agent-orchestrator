/**
 * Dashboard cache utilities — cleans stale .next artifacts and detects
 * running dashboard processes.
 */

import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import ora from "ora";
import { exec, execSilent } from "./shell.js";

// Match node_modules as a path segment, not just a substring.
export function isInstalledUnderNodeModules(path: string): boolean {
  return path.includes("/node_modules/") || path.includes("\\node_modules\\");
}

/**
 * Find the PID of a process listening on the given port.
 * Returns null if no process is found.
 */
export async function findRunningDashboardPid(port: number): Promise<string | null> {
  const lsofOutput = await execSilent("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]);
  if (!lsofOutput) return null;

  const pid = lsofOutput.split("\n")[0]?.trim();
  if (!pid || !/^\d+$/.test(pid)) return null;
  return pid;
}

/**
 * Find the working directory of a process by PID.
 * Returns null if the cwd can't be determined.
 */
export async function findProcessWebDir(pid: string): Promise<string | null> {
  const lsofDetail = await execSilent("lsof", ["-p", pid, "-Ffn"]);
  if (!lsofDetail) return null;

  // lsof -Fn outputs lines like "n/path/to/cwd" — the cwd entry follows "fcwd"
  const lines = lsofDetail.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "fcwd" && i + 1 < lines.length && lines[i + 1]?.startsWith("n/")) {
      const cwd = lines[i + 1].slice(1);
      if (existsSync(resolve(cwd, "package.json"))) {
        return cwd;
      }
    }
  }

  return null;
}

/**
 * Wait for a port to be free (no process listening).
 * Throws if the port is still busy after the timeout.
 */
export async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pid = await findRunningDashboardPid(port);
    if (!pid) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Port ${port} still in use after ${timeoutMs}ms — old process did not exit in time`);
}

/**
 * Remove the .next directory before a rebuild.
 */
export async function cleanNextCache(webDir: string): Promise<void> {
  const nextDir = resolve(webDir, ".next");
  if (existsSync(nextDir)) {
    const spinner = ora();
    spinner.start("Cleaning .next build cache");
    rmSync(nextDir, { recursive: true, force: true });
    spinner.succeed(`Cleaned .next build cache (${webDir})`);
  }
}

/**
 * Rebuild dashboard production artifacts from a source checkout.
 * Global npm installs ship prebuilt artifacts and cannot rebuild in place.
 */
export function assertDashboardRebuildSupported(webDir: string): void {
  if (isInstalledUnderNodeModules(webDir)) {
    throw new Error(
      "Dashboard rebuild is only available from a source checkout. " +
      "Run `ao update`, or reinstall with `npm install -g @composio/ao@latest`.",
    );
  }
}

/**
 * Rebuild dashboard production artifacts from a source checkout.
 * Global npm installs ship prebuilt artifacts and cannot rebuild in place.
 */
export async function rebuildDashboardProductionArtifacts(webDir: string): Promise<void> {
  assertDashboardRebuildSupported(webDir);

  await cleanNextCache(webDir);

  const workspaceRoot = resolve(webDir, "../..");
  const spinner = ora("Rebuilding dashboard production artifacts").start();

  try {
    await exec("pnpm", ["build"], { cwd: workspaceRoot });
    spinner.succeed("Rebuilt dashboard production artifacts");
  } catch (error) {
    spinner.fail("Dashboard rebuild failed");
    throw new Error(
      "Failed to rebuild dashboard production artifacts. Run `pnpm build` and try again.",
      { cause: error },
    );
  }
}
