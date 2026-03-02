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
import { existsSync, statSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import {
  loadConfig,
  LogWriter,
  readLogs,
  tailLogs,
  restartDashboard,
  waitForHealthy,
  readPidFile,
  writePidFile,
  removePidFile,
  type LogEntry,
  type LogQueryOptions,
} from "@composio/ao-core";
import { findWebDir, buildDashboardEnv } from "../lib/web-dir.js";
import {
  cleanNextCache,
  findRunningDashboardPid,
  findProcessWebDir,
  waitForPortFree,
} from "../lib/dashboard-rebuild.js";
import { formatAge, formatLogEntry, parseSinceArg } from "../lib/format.js";
import { resolveLogDir as resolveLogDirStrict } from "../lib/perf-utils.js";

/** Nullable variant — dashboard degrades gracefully when no project is configured. */
function resolveLogDir(): string | null {
  try {
    return resolveLogDirStrict();
  } catch {
    return null;
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
    writePidFile(logDir, child.pid);
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
    if (logDir) removePidFile(logDir);

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
        if (logDir) removePidFile(logDir);
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
    .option("--wait", "Wait for dashboard to be healthy before exiting")
    .action(async (opts: { port?: string; clean?: boolean; open?: boolean; wait?: boolean }) => {
      try {
        const config = loadConfig();
        const port = opts.port ? parseInt(opts.port, 10) : (config.port ?? 3000);
        const logDir = resolveLogDir();
        const webDir = findWebDir();

        if (!logDir) {
          console.error(chalk.red("No log directory found. Is a project configured?"));
          process.exit(1);
        }

        // Use the core restartDashboard function
        const result = await restartDashboard({
          clean: opts.clean,
          port,
          webDir,
          logDir,
          configPath: config.configPath,
          onStatus: (msg) => console.log(chalk.dim(msg)),
        });

        if (result.pid) {
          console.log(chalk.green(`Dashboard restarted (PID ${result.pid}) on port ${port}`));
        } else {
          console.error(chalk.red("Failed to start dashboard."));
          process.exit(1);
        }

        // Optionally wait for healthy
        if (opts.wait) {
          console.log(chalk.dim("Waiting for dashboard to be ready..."));
          const healthy = await waitForHealthy(port, 30_000);
          if (healthy) {
            console.log(chalk.green("Dashboard is healthy."));
          } else {
            console.error(chalk.yellow("Dashboard did not become healthy within 30s."));
          }
        }

        // Open browser if requested
        if (opts.open !== false && result.pid) {
          setTimeout(() => {
            const browser = spawn("open", [`http://localhost:${port}`], { stdio: "ignore" });
            browser.on("error", () => {});
          }, opts.wait ? 0 : 3000);
        }
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
          const filePid = readPidFile(logDir);
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
            running = true;
          } else if (pid && portPid !== pid) {
            // PID file points to one process, but a different process is on the port — conflict
            console.log(
              `  Process:  ${chalk.yellow("conflict")} ` +
                `(PID file: ${pid}, but port ${port} held by PID ${portPid})`,
            );
            running = false;
            pid = null;
          }
          // else: PID file matches port process — both agree, fall through to "running"
        } else if (running) {
          // PID file says running but port is free — stale PID
          console.log(
            `  Process:  ${chalk.yellow("stale")} (PID file exists but port ${port} is free)`,
          );
          if (logDir) removePidFile(logDir);
          running = false;
          pid = null;
        }

        if (running && pid) {
          console.log(`  Process:  ${chalk.green("running")} (PID ${pid}, via ${pidSource})`);
        } else if (!pid) {
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

        let entries: LogEntry[];
        if (opts.since) {
          const queryOpts: LogQueryOptions = {
            since: parseSinceArg(opts.since),
            level: opts.level ? [opts.level as LogEntry["level"]] : undefined,
          };
          entries = readLogs(logFile, queryOpts);
        } else {
          const n = parseInt(opts.tail ?? "50", 10);
          entries = tailLogs(logFile, n);
          if (opts.level) {
            entries = entries.filter((e) => e.level === opts.level);
          }
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
