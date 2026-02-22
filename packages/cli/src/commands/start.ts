/**
 * `ao start` and `ao stop` commands — unified orchestrator startup.
 *
 * Starts the dashboard and orchestrator agent session. The orchestrator prompt
 * is passed to the agent via --append-system-prompt (or equivalent flag) at
 * launch time — no file writing required.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, openSync, closeSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  generateOrchestratorPrompt,
  getLogsDir,
  LogWriter,
  readPidFile,
  writePidFile,
  removePidFile,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { findWebDir, buildDashboardEnv } from "../lib/web-dir.js";
import { cleanNextCache } from "../lib/dashboard-rebuild.js";

/**
 * Resolve project from config.
 * If projectArg is provided, use it. If only one project exists, use that.
 * Otherwise, error with helpful message.
 */
function resolveProject(
  config: OrchestratorConfig,
  projectArg?: string,
): { projectId: string; project: ProjectConfig } {
  const projectIds = Object.keys(config.projects);

  if (projectIds.length === 0) {
    throw new Error("No projects configured. Add a project to agent-orchestrator.yaml.");
  }

  // Explicit project argument
  if (projectArg) {
    const project = config.projects[projectArg];
    if (!project) {
      throw new Error(
        `Project "${projectArg}" not found. Available projects:\n  ${projectIds.join(", ")}`,
      );
    }
    return { projectId: projectArg, project };
  }

  // Only one project — use it
  if (projectIds.length === 1) {
    const projectId = projectIds[0];
    return { projectId, project: config.projects[projectId] };
  }

  // Multiple projects, no argument — error
  throw new Error(
    `Multiple projects configured. Specify which one to start:\n  ${projectIds.map((id) => `ao start ${id}`).join("\n  ")}`,
  );
}

/**
 * Start dashboard server with log capture.
 *
 * Two modes:
 * - Foreground (default): live output to terminal + logging to files
 * - Background: daemonized, logs go to files only, process detached
 */
async function startDashboard(
  port: number,
  webDir: string,
  configPath: string | null,
  logDir: string | null,
  background: boolean,
  terminalPort?: number,
  directTerminalPort?: number,
): Promise<ChildProcess> {
  const env = await buildDashboardEnv(port, configPath, terminalPort, directTerminalPort);

  // In background mode, redirect stdout/stderr directly to a log file via
  // file descriptors so logging continues after the parent process exits.
  // In foreground mode, pipe through the parent to show output + log via LogWriter.
  if (background && logDir) {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const outFd = openSync(join(logDir, "dashboard.out.log"), "a");
    const errFd = openSync(join(logDir, "dashboard.err.log"), "a");

    const child = spawn("pnpm", ["run", "dev"], {
      cwd: webDir,
      stdio: ["ignore", outFd, errFd],
      detached: true,
      env,
    });

    // Close FDs in the parent — the child has its own copies via dup2
    closeSync(outFd);
    closeSync(errFd);

    child.unref();

    if (child.pid) {
      writePidFile(logDir, child.pid);
    }

    return child;
  }

  // Foreground mode: pipe through parent for live output + structured logging
  const logWriter = logDir
    ? new LogWriter({ filePath: join(logDir, "dashboard.jsonl") })
    : null;

  const child = spawn("pnpm", ["run", "dev"], {
    cwd: webDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: background,
    env,
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    if (!background) process.stdout.write(chunk);
    if (logWriter) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        logWriter.appendLine(line, "stdout", "dashboard");
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (!background) process.stderr.write(chunk);
    if (logWriter) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        logWriter.appendLine(line, "stderr", "dashboard");
      }
    }
  });

  if (background) {
    child.unref();
    // Write PID to file for `ao stop` to find it
    if (logDir && child.pid) {
      writePidFile(logDir, child.pid);
    }
  }

  child.on("error", (err) => {
    console.error(chalk.red("Dashboard failed to start:"), err.message);
    child.emit("exit", 1, null);
  });

  child.once("exit", () => {
    if (logWriter) logWriter.close();
  });

  return child;
}

/**
 * Stop dashboard server.
 * First tries PID file (from background mode), then falls back to lsof.
 * Best effort — if it fails, just warn the user.
 */
async function stopDashboard(port: number, logDir: string | null): Promise<void> {
  // Try PID file first (from background mode).
  // readPidFile validates the process is alive via kill(pid, 0) and cleans up stale files.
  if (logDir) {
    const pid = readPidFile(logDir);
    if (pid !== null) {
      try {
        await exec("kill", [String(pid)]);
        removePidFile(logDir);
        console.log(chalk.green("Dashboard stopped (via PID file)"));
        return;
      } catch {
        // Process gone between readPidFile and kill — clean up and fall through
        removePidFile(logDir);
      }
    }
  }

  // Fallback: find via lsof
  try {
    const { stdout } = await exec("lsof", ["-ti", `:${port}`]);
    const pids = stdout
      .trim()
      .split("\n")
      .filter((p) => p.length > 0);

    if (pids.length > 0) {
      await exec("kill", pids);
      console.log(chalk.green("Dashboard stopped"));
    } else {
      console.log(chalk.yellow(`Dashboard not running on port ${port}`));
    }
  } catch {
    console.log(chalk.yellow("Could not stop dashboard (may not be running)"));
  }
}

export function registerStart(program: Command): void {
  program
    .command("start [project]")
    .description("Start orchestrator agent and dashboard for a project")
    .option("--no-dashboard", "Skip starting the dashboard server")
    .option("--no-orchestrator", "Skip starting the orchestrator agent")
    .option("--rebuild", "Clean and rebuild dashboard before starting")
    .option("-b, --background", "Run dashboard in background (logs to file only)")
    .action(
      async (
        projectArg?: string,
        opts?: {
          dashboard?: boolean;
          orchestrator?: boolean;
          rebuild?: boolean;
          background?: boolean;
        },
      ) => {
        try {
          const config = loadConfig();
          const { projectId, project } = resolveProject(config, projectArg);
          const sessionId = `${project.sessionPrefix}-orchestrator`;
          const port = config.port ?? 3000;

          // Resolve log directory for the project
          const logDir = config.configPath
            ? getLogsDir(config.configPath, project.path)
            : null;
          const background = opts?.background ?? false;

          console.log(chalk.bold(`\nStarting orchestrator for ${chalk.cyan(project.name)}\n`));

          // Start dashboard (unless --no-dashboard)
          const spinner = ora();
          let dashboardProcess: ChildProcess | null = null;
          let exists = false; // Track whether orchestrator session already exists

          if (opts?.dashboard !== false) {
            const webDir = findWebDir();
            if (!existsSync(resolve(webDir, "package.json"))) {
              throw new Error("Could not find @composio/ao-web package. Run: pnpm install");
            }

            if (opts?.rebuild) {
              await cleanNextCache(webDir);
            }

            spinner.start("Starting dashboard");
            dashboardProcess = await startDashboard(
              port,
              webDir,
              config.configPath,
              logDir,
              background,
              config.terminalPort,
              config.directTerminalPort,
            );
            spinner.succeed(
              `Dashboard starting on http://localhost:${port}${background ? " (background)" : ""}`,
            );
            if (logDir) {
              console.log(chalk.dim(`  Logs: ${logDir}/dashboard.jsonl`));
            }
            console.log(chalk.dim("  (Dashboard will be ready in a few seconds)\n"));
          }

          // Create orchestrator session (unless --no-orchestrator or already exists)
          let tmuxTarget = sessionId; // For the attach hint — updated to hash-based name after spawn
          if (opts?.orchestrator !== false) {
            const sm = await getSessionManager(config);

            // Check if orchestrator session already exists
            const existing = await sm.get(sessionId);
            exists = existing !== null && existing.status !== "killed";

            if (exists) {
              if (existing?.runtimeHandle?.id) {
                tmuxTarget = existing.runtimeHandle.id;
              }
              console.log(
                chalk.yellow(
                  `Orchestrator session "${sessionId}" is already running (skipping creation)`,
                ),
              );
            } else {
              try {
                spinner.start("Creating orchestrator session");
                const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });

                const session = await sm.spawnOrchestrator({ projectId, systemPrompt });
                if (session.runtimeHandle?.id) {
                  tmuxTarget = session.runtimeHandle.id;
                }
                spinner.succeed("Orchestrator session created");
              } catch (err) {
                spinner.fail("Orchestrator setup failed");
                // Cleanup dashboard if orchestrator setup fails
                if (dashboardProcess) {
                  dashboardProcess.kill();
                }
                throw new Error(
                  `Failed to setup orchestrator: ${err instanceof Error ? err.message : String(err)}`,
                  { cause: err },
                );
              }
            }
          }

          // Print summary based on what was actually started
          console.log(chalk.bold.green("\n✓ Startup complete\n"));

          if (opts?.dashboard !== false) {
            console.log(chalk.cyan("Dashboard:"), `http://localhost:${port}`);
          }

          if (opts?.orchestrator !== false && !exists) {
            console.log(chalk.cyan("Orchestrator:"), `tmux attach -t ${tmuxTarget}`);
          } else if (exists) {
            console.log(chalk.cyan("Orchestrator:"), `already running (${sessionId})`);
          }

          console.log(chalk.dim(`Config: ${config.configPath}\n`));

          // Keep dashboard process alive if it was started
          if (dashboardProcess) {
            dashboardProcess.on("exit", (code) => {
              if (code !== 0 && code !== null) {
                console.error(chalk.red(`Dashboard exited with code ${code}`));
              }
              process.exit(code ?? 0);
            });
          }
        } catch (err) {
          if (err instanceof Error) {
            if (err.message.includes("No agent-orchestrator.yaml found")) {
              console.error(chalk.red("\nNo config found. Run:"));
              console.error(chalk.cyan("  ao init\n"));
            } else {
              console.error(chalk.red("\nError:"), err.message);
            }
          } else {
            console.error(chalk.red("\nError:"), String(err));
          }
          process.exit(1);
        }
      },
    );
}

export function registerStop(program: Command): void {
  program
    .command("stop [project]")
    .description("Stop orchestrator agent and dashboard for a project")
    .action(async (projectArg?: string) => {
      try {
        const config = loadConfig();
        const { projectId: _projectId, project } = resolveProject(config, projectArg);
        const sessionId = `${project.sessionPrefix}-orchestrator`;
        const port = config.port ?? 3000;

        console.log(chalk.bold(`\nStopping orchestrator for ${chalk.cyan(project.name)}\n`));

        // Kill orchestrator session via SessionManager
        const sm = await getSessionManager(config);
        const existing = await sm.get(sessionId);

        if (existing) {
          const spinner = ora("Stopping orchestrator session").start();
          await sm.kill(sessionId);
          spinner.succeed("Orchestrator session stopped");
        } else {
          console.log(chalk.yellow(`Orchestrator session "${sessionId}" is not running`));
        }

        // Stop dashboard
        const logDir = config.configPath
          ? getLogsDir(config.configPath, project.path)
          : null;
        await stopDashboard(port, logDir);

        console.log(chalk.bold.green("\n✓ Orchestrator stopped\n"));
      } catch (err) {
        if (err instanceof Error) {
          console.error(chalk.red("\nError:"), err.message);
        } else {
          console.error(chalk.red("\nError:"), String(err));
        }
        process.exit(1);
      }
    });
}
