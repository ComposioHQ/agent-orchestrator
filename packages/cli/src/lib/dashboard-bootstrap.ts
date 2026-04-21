/**
 * Dashboard process management — start, stop, and kill-by-port detection.
 *
 * The dashboard is a Next.js process (plus two WebSocket servers) spawned as a
 * child of `ao start`. We detect dev-mode vs production bundles by the presence
 * of `server/` (monorepo) vs `dist-server/` (published npm).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { buildDashboardEnv, MAX_PORT_SCAN } from "./web-dir.js";
import { exec } from "./shell.js";
import { formatCommandError } from "./cli-errors.js";
import { genericInstallHints } from "./installer.js";

/**
 * Start dashboard server in the background.
 * Returns the child process handle for cleanup.
 */
/* c8 ignore start -- process-spawning startup code, tested via integration/onboarding */
export async function startDashboard(
  port: number,
  webDir: string,
  configPath: string | null,
  terminalPort?: number,
  directTerminalPort?: number,
  devMode?: boolean,
): Promise<ChildProcess> {
  const env = await buildDashboardEnv(port, configPath, terminalPort, directTerminalPort);

  // Detect monorepo vs npm install: the `server/` source directory only exists
  // in the monorepo. Published npm packages only have `dist-server/`.
  const isMonorepo = existsSync(resolve(webDir, "server"));

  // In monorepo: use HMR dev server only when --dev is passed explicitly.
  // Default is optimized production server for faster loading.
  const useDevServer = isMonorepo && devMode === true;

  let child: ChildProcess;
  if (useDevServer) {
    // Monorepo with --dev: use pnpm run dev (tsx watch, HMR, etc.)
    console.log(chalk.dim("  Mode: development (HMR enabled)"));
    child = spawn("pnpm", ["run", "dev"], {
      cwd: webDir,
      stdio: "inherit",
      detached: false,
      env,
    });
  } else {
    // Production: use pre-built start-all script.
    if (isMonorepo) {
      console.log(chalk.dim("  Mode: optimized (production bundles)"));
      console.log(chalk.dim("  Tip: use --dev for hot reload when editing dashboard UI\n"));
    }
    const startScript = resolve(webDir, "dist-server", "start-all.js");
    child = spawn("node", [startScript], {
      cwd: webDir,
      stdio: "inherit",
      detached: false,
      env,
    });
  }

  child.on("error", (err) => {
    const cmd = useDevServer ? "pnpm" : "node";
    const args = useDevServer ? ["run", "dev"] : [resolve(webDir, "dist-server", "start-all.js")];
    const formatted = formatCommandError(err, {
      cmd,
      args,
      action: "start the AO dashboard",
      installHints: genericInstallHints(cmd),
    });
    console.error(chalk.red("Dashboard failed to start:"), formatted.message);
    // Emit synthetic exit so callers listening on "exit" can clean up
    child.emit("exit", 1, null);
  });

  return child;
}
/* c8 ignore stop */

/** Pattern matching AO dashboard processes (production and dev mode). */
const DASHBOARD_CMD_PATTERN = /next-server|start-all\.js|next dev|ao-web/;

/**
 * Check whether a process listening on the given port is an AO dashboard
 * (next-server, start-all.js, or next dev). Only kills matching PIDs,
 * leaving unrelated co-listeners (sidecars, SO_REUSEPORT) untouched.
 */
async function killDashboardOnPort(port: number): Promise<boolean> {
  try {
    const { stdout } = await exec("lsof", ["-ti", `:${port}`]);
    const pids = stdout
      .trim()
      .split("\n")
      .filter((p) => p.length > 0);
    if (pids.length === 0) return false;

    // Filter to only dashboard PIDs
    const dashboardPids: string[] = [];
    for (const pid of pids) {
      try {
        const { stdout: cmdline } = await exec("ps", ["-p", pid, "-o", "args="]);
        if (DASHBOARD_CMD_PATTERN.test(cmdline)) {
          dashboardPids.push(pid);
        }
      } catch {
        // process vanished — skip
      }
    }
    if (dashboardPids.length === 0) return false;

    await exec("kill", dashboardPids);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop dashboard server.
 * Uses lsof to find the process listening on the port, then kills it.
 * Best effort — if it fails, just warn the user.
 */
export async function stopDashboard(port: number): Promise<void> {
  // 1. Try the expected port — verify it's a dashboard before killing
  if (await killDashboardOnPort(port)) {
    console.log(chalk.green("Dashboard stopped"));
    return;
  }

  // 2. Fallback: scan nearby ports to find an orphaned dashboard
  //    that was auto-reassigned when the original port was busy.
  //    Uses killDashboardOnPort to verify the process is actually an
  //    AO dashboard before killing, avoiding collateral damage.
  for (let p = port + 1; p <= port + MAX_PORT_SCAN; p++) {
    if (await killDashboardOnPort(p)) {
      console.log(chalk.green(`Dashboard stopped (was on port ${p})`));
      return;
    }
  }

  console.log(chalk.yellow("Could not stop dashboard (may not be running)"));
}
