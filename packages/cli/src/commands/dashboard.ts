/**
 * `ao dashboard` — manage the web dashboard process.
 *
 * Subcommands:
 *   ao dashboard              — start the dashboard (default)
 *   ao dashboard restart      — kill + restart (--clean to wipe .next)
 *   ao dashboard status       — show running state, port, cache info
 *   ao dashboard logs         — tail dashboard logs
 */

import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { existsSync, statSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, getLogsDir, LogWriter, tailLogs, type LogEntry } from "@composio/ao-core";
import { findWebDir, buildDashboardEnv } from "../lib/web-dir.js";
import {
  cleanNextCache,
  findRunningDashboardPid,
  findProcessWebDir,
  waitForPortFree,
} from "../lib/dashboard-rebuild.js";
import { formatAge } from "../lib/format.js";

/** Resolve the log directory for the first configured project. */
function resolveLogDir(): string | null {
  try {
    const config = loadConfig();
    const projectId = Object.keys(config.projects)[0];
    if (!projectId) return null;
    const project = config.projects[projectId];
    return getLogsDir(config.configPath, project.path);
  } catch {
    return null;
  }
}

/** Read the PID from the dashboard.pid file, verify it's still running. */
function readDashboardPid(logDir: string): number | null {
  const pidFile = join(logDir, "dashboard.pid");
  if (!existsSync(pidFile)) return null;

  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;

    // Check if process is still alive
    process.kill(pid, 0); // signal 0 = test if process exists
    return pid;
  } catch {
    // Process doesn't exist — clean up stale PID file
    try {
      unlinkSync(pidFile);
    } catch {
      // best effort
    }
    return null;
  }
}

/** Write dashboard PID to file. */
function writeDashboardPid(logDir: string, pid: number): void {
  const pidFile = join(logDir, "dashboard.pid");
  writeFileSync(pidFile, String(pid), "utf-8");
}

/** Clean up dashboard PID file. */
function removeDashboardPid(logDir: string): void {
  const pidFile = join(logDir, "dashboard.pid");
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile);
  } catch {
    // best effort
  }
}

/** Get .next cache stats (size, age). */
function getNextCacheStats(webDir: string): { exists: boolean; sizeBytes: number; ageMs: number } | null {
  const nextDir = resolve(webDir, ".next");
  if (!existsSync(nextDir)) return null;

  try {
    const stat = statSync(nextDir);
    return {
      exists: true,
      sizeBytes: getDirSizeApprox(nextDir),
      ageMs: Date.now() - stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

/** Approximate directory size by stat-ing the directory itself (not recursive). */
function getDirSizeApprox(dir: string): number {
  try {
    return statSync(dir).size;
  } catch {
    return 0;
  }
}

/** Format bytes to human readable. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Check if stderr output suggests stale build artifacts. */
function looksLikeStaleBuild(stderr: string): boolean {
  const patterns = [
    /Cannot find module.*vendor-chunks/,
    /Cannot find module.*\.next/,
    /Module not found.*\.next/,
    /ENOENT.*\.next/,
    /Could not find a production build/,
  ];
  return patterns.some((p) => p.test(stderr));
}

/** Format a log entry for terminal display. */
function formatLogEntry(entry: LogEntry): string {
  const ts = new Date(entry.ts).toLocaleTimeString();
  const level =
    entry.level === "error" ? chalk.red("ERR") :
    entry.level === "warn" ? chalk.yellow("WRN") :
    entry.level === "stderr" ? chalk.red("err") :
    entry.level === "info" ? chalk.blue("inf") :
    chalk.dim("out");
  return `${chalk.dim(ts)} ${level} ${entry.message}`;
}

/**
 * Start the dashboard process with logging and PID tracking.
 */
async function startDashboardProcess(
  port: number,
  webDir: string,
  configPath: string | null,
  logDir: string | null,
  opts: { open?: boolean; terminalPort?: number; directTerminalPort?: number },
): Promise<void> {
  console.log(chalk.bold(`Starting dashboard on http://localhost:${port}\n`));

  const env = await buildDashboardEnv(port, configPath, opts.terminalPort, opts.directTerminalPort);

  const logWriter = logDir
    ? new LogWriter({ filePath: join(logDir, "dashboard.jsonl") })
    : null;

  const child = spawn("npx", ["next", "dev", "-p", String(port)], {
    cwd: webDir,
    stdio: ["inherit", "pipe", "pipe"],
    env,
  });

  // Write PID file for process tracking
  if (logDir && child.pid) {
    writeDashboardPid(logDir, child.pid);
  }

  const stderrChunks: string[] = [];
  const MAX_STDERR_CHUNKS = 100;

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    if (logWriter) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        logWriter.appendLine(line, "stdout", "dashboard");
      }
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    if (stderrChunks.length < MAX_STDERR_CHUNKS) {
      stderrChunks.push(text);
    }
    process.stderr.write(data);
    if (logWriter) {
      for (const line of text.split("\n").filter(Boolean)) {
        logWriter.appendLine(line, "stderr", "dashboard");
      }
    }
  });

  child.on("error", (err) => {
    console.error(chalk.red("Could not start dashboard. Ensure Next.js is installed."));
    console.error(chalk.dim(String(err)));
    process.exit(1);
  });

  let browserTimer: ReturnType<typeof setTimeout> | undefined;

  if (opts.open !== false) {
    browserTimer = setTimeout(() => {
      const browser = spawn("open", [`http://localhost:${port}`], { stdio: "ignore" });
      browser.on("error", () => {});
    }, 3000);
  }

  child.on("exit", (code) => {
    if (browserTimer) clearTimeout(browserTimer);
    if (logWriter) logWriter.close();
    if (logDir) removeDashboardPid(logDir);

    if (code !== 0 && code !== null) {
      const stderr = stderrChunks.join("");
      if (looksLikeStaleBuild(stderr)) {
        console.error(
          chalk.yellow(
            "\nThis looks like a stale build cache issue. Try:\n\n" +
              `  ${chalk.cyan("ao dashboard restart --clean")}\n`,
          ),
        );
      }
    }

    process.exit(code ?? 0);
  });
}

export function registerDashboard(program: Command): void {
  const dashCmd = program
    .command("dashboard")
    .description("Manage the web dashboard");

  // --- ao dashboard start (also the default action) ---
  const startAction = async (opts: {
    port?: string;
    open?: boolean;
    rebuild?: boolean;
  }) => {
    const config = loadConfig();
    const port = opts.port ? parseInt(opts.port, 10) : (config.port ?? 3000);

    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(chalk.red("Invalid port number. Must be 1-65535."));
      process.exit(1);
    }

    const localWebDir = findWebDir();

    if (!existsSync(resolve(localWebDir, "package.json"))) {
      console.error(
        chalk.red(
          "Could not find @composio/ao-web package.\n" + "Ensure it is installed: pnpm install",
        ),
      );
      process.exit(1);
    }

    const logDir = resolveLogDir();

    if (opts.rebuild) {
      const runningPid = await findRunningDashboardPid(port);
      const runningWebDir = runningPid ? await findProcessWebDir(runningPid) : null;
      const targetWebDir = runningWebDir ?? localWebDir;

      if (runningPid) {
        console.log(chalk.dim(`Stopping dashboard (PID ${runningPid}) on port ${port}...`));
        try {
          process.kill(parseInt(runningPid, 10), "SIGTERM");
        } catch {
          // Process already exited
        }
        await waitForPortFree(port, 5000);
        if (logDir) removeDashboardPid(logDir);
      }

      await cleanNextCache(targetWebDir);
    }

    await startDashboardProcess(port, localWebDir, config.configPath, logDir, {
      ...opts,
      terminalPort: config.terminalPort,
      directTerminalPort: config.directTerminalPort,
    });
  };

  // Default action: `ao dashboard` with no subcommand starts the dashboard
  dashCmd
    .option("-p, --port <port>", "Port to listen on")
    .option("--no-open", "Don't open browser automatically")
    .option("--rebuild", "Clean stale build artifacts and rebuild before starting")
    .action(startAction);

  // --- ao dashboard restart ---
  dashCmd
    .command("restart")
    .description("Kill running dashboard and restart (--clean to wipe .next cache)")
    .option("-p, --port <port>", "Port to listen on")
    .option("--clean", "Clean .next cache before restarting")
    .option("--no-open", "Don't open browser after restart")
    .action(async (opts: { port?: string; clean?: boolean; open?: boolean }) => {
      try {
        const config = loadConfig();
        const port = opts.port ? parseInt(opts.port, 10) : (config.port ?? 3000);
        const logDir = resolveLogDir();
        const webDir = findWebDir();

        // 1. Find and kill existing dashboard
        let pid: string | null = null;

        // Try PID file first
        if (logDir) {
          const filePid = readDashboardPid(logDir);
          if (filePid) pid = String(filePid);
        }

        // Fallback to lsof
        if (!pid) {
          pid = await findRunningDashboardPid(port);
        }

        if (pid) {
          console.log(chalk.dim(`Stopping dashboard (PID ${pid}) on port ${port}...`));
          try {
            process.kill(parseInt(pid, 10), "SIGTERM");
          } catch {
            // Process already exited
          }
          await waitForPortFree(port, 5000);
          if (logDir) removeDashboardPid(logDir);
          console.log(chalk.green("Dashboard stopped."));
        } else {
          console.log(chalk.dim("No running dashboard found."));
        }

        // 2. Optionally clean .next cache
        if (opts.clean) {
          await cleanNextCache(webDir);
        }

        // 3. Restart
        await startDashboardProcess(port, webDir, config.configPath, logDir, {
          ...opts,
          terminalPort: config.terminalPort,
          directTerminalPort: config.directTerminalPort,
        });
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // --- ao dashboard status ---
  dashCmd
    .command("status")
    .description("Show dashboard process status, port, and cache info")
    .option("-p, --port <port>", "Port to check")
    .action(async (opts: { port?: string }) => {
      try {
        const config = loadConfig();
        const port = opts.port ? parseInt(opts.port, 10) : (config.port ?? 3000);
        const logDir = resolveLogDir();
        const webDir = findWebDir();

        console.log(chalk.bold("\nDashboard Status\n"));

        // Process status
        let running = false;
        let pid: string | null = null;
        let pidSource = "";

        // Check PID file
        if (logDir) {
          const filePid = readDashboardPid(logDir);
          if (filePid) {
            pid = String(filePid);
            pidSource = "pid file";
            running = true;
          }
        }

        // Check port via lsof
        const portPid = await findRunningDashboardPid(port);
        if (portPid) {
          if (!running) {
            pid = portPid;
            pidSource = "port scan";
          }
          running = true;
        } else if (running) {
          // PID file says running but port is free — stale PID
          console.log(
            `  Process:  ${chalk.yellow("stale")} (PID file exists but port ${port} is free)`,
          );
          if (logDir) removeDashboardPid(logDir);
          running = false;
          pid = null;
        }

        if (running && pid) {
          console.log(`  Process:  ${chalk.green("running")} (PID ${pid}, via ${pidSource})`);
        } else if (!running) {
          console.log(`  Process:  ${chalk.dim("not running")}`);
        }

        console.log(`  Port:     ${port}`);

        // Port conflict detection
        if (!running && portPid) {
          const portWebDir = await findProcessWebDir(portPid);
          console.log(
            `  Conflict: ${chalk.yellow(`Port ${port} is in use by PID ${portPid}`)}` +
              (portWebDir ? chalk.dim(` (${portWebDir})`) : ""),
          );
        }

        // .next cache info
        const cacheStats = getNextCacheStats(webDir);
        if (cacheStats) {
          console.log(
            `  Cache:    ${chalk.cyan(".next")} exists ` +
              `(${formatAge(Date.now() - cacheStats.ageMs)} old)`,
          );
        } else {
          console.log(`  Cache:    ${chalk.dim("no .next cache")}`);
        }

        // Log file info
        if (logDir) {
          const logFile = join(logDir, "dashboard.jsonl");
          if (existsSync(logFile)) {
            try {
              const logStat = statSync(logFile);
              console.log(
                `  Log:      ${formatBytes(logStat.size)} ` +
                  `(${formatAge(logStat.mtimeMs)} updated)`,
              );
            } catch {
              console.log(`  Log:      ${chalk.dim("unreadable")}`);
            }
          } else {
            console.log(`  Log:      ${chalk.dim("no logs yet")}`);
          }
          console.log(`  Log dir:  ${chalk.dim(logDir)}`);
        }

        // Web dir
        console.log(`  Web dir:  ${chalk.dim(webDir)}`);

        console.log();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // --- ao dashboard logs ---
  dashCmd
    .command("logs")
    .description("Tail dashboard process logs")
    .option("--tail <n>", "Number of lines to show", "50")
    .option("--since <time>", "Show logs since (e.g., 5m, 1h)")
    .option("--level <level>", "Filter by level (stdout, stderr)")
    .option("--json", "Output as JSON")
    .action((opts: { tail?: string; since?: string; level?: string; json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        if (!logDir) {
          console.error(chalk.red("No log directory found. Is a project configured?"));
          process.exit(1);
        }

        const logFile = join(logDir, "dashboard.jsonl");
        if (!existsSync(logFile)) {
          console.log(chalk.dim("No dashboard logs yet. Start the dashboard first."));
          return;
        }

        const n = parseInt(opts.tail ?? "50", 10);
        let entries = tailLogs(logFile, n);

        if (opts.level) {
          entries = entries.filter((e) => e.level === opts.level);
        }

        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
        } else if (entries.length === 0) {
          console.log(chalk.dim("No log entries found."));
        } else {
          for (const entry of entries) {
            console.log(formatLogEntry(entry));
          }
          console.log(chalk.dim(`\n${entries.length} entries`));
        }
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
