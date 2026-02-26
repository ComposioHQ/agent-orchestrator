import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, type OrchestratorConfig } from "@composio/ao-core";
import { findWebDir, buildDashboardEnv } from "../lib/web-dir.js";
import {
  cleanNextCache,
  findRunningDashboardPid,
  findProcessWebDir,
  waitForPortFree,
  waitForPortsFree,
  terminateListenersOnPorts,
} from "../lib/dashboard-rebuild.js";
import {
  createLifecycleRunner,
  DEFAULT_LIFECYCLE_POLL_INTERVAL_MS,
  type LifecycleRunner,
} from "../lib/lifecycle-runner.js";
import {
  tryAcquireLifecycleLock,
  releaseLifecycleLock,
  type AcquiredLifecycleLock,
} from "../lib/lifecycle-lock.js";

interface DashboardOptions {
  port?: string;
  open?: boolean;
  rebuild?: boolean;
  lifecycle?: boolean;
}

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Start the web dashboard")
    .option("-p, --port <port>", "Port to listen on")
    .option("--no-open", "Don't open browser automatically")
    .option("--rebuild", "Clean stale build artifacts and rebuild before starting")
    .option("--no-lifecycle", "Start dashboard without lifecycle poller integration")
    .action(async (opts: DashboardOptions) => {
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

      // Prevent partial startup: if port is already occupied, Next will fail with
      // EADDRINUSE while terminal websocket processes may still boot, leaving a
      // confusing mixed state. Detect early and stop with an actionable message.
      if (!opts.rebuild) {
        const runningPid = await findRunningDashboardPid(port);
        if (runningPid) {
          const runningWebDir = await findProcessWebDir(runningPid);
          if (runningWebDir) {
            console.error(
              chalk.yellow(
                `Dashboard already running on port ${port} (PID ${runningPid}).`,
              ),
            );
            console.log(chalk.dim(`Use ${chalk.cyan("ao dashboard --rebuild")} to restart cleanly.`));
            return;
          }

          console.error(chalk.red(`Port ${port} is already in use (PID ${runningPid}).`));
          console.log(chalk.dim(`Use ${chalk.cyan("--port <port>")} or free the port first.`));
          return;
        }
      }

      if (opts.rebuild) {
        // Check if a dashboard is already running on this port.
        const runningPid = await findRunningDashboardPid(port);
        const runningWebDir = runningPid ? await findProcessWebDir(runningPid) : null;
        const targetWebDir = runningWebDir ?? localWebDir;
        const terminalPort = config.terminalPort ?? 14800;
        const directTerminalPort = config.directTerminalPort ?? 14801;
        const portsToRecycle = [port, terminalPort, directTerminalPort];

        if (runningPid) {
          // Kill listeners on dashboard + websocket ports, then start fresh below.
          console.log(
            chalk.dim(`Stopping dashboard (PID ${runningPid}) on port ${port}...`),
          );
          await terminateListenersOnPorts(portsToRecycle);
          await waitForPortsFree(portsToRecycle, 5000);
        } else {
          // Even without a listener on main port, leftover terminal websocket
          // listeners can block clean startup during rebuild.
          await terminateListenersOnPorts(portsToRecycle);
          await waitForPortFree(port, 5000);
        }

        await cleanNextCache(targetWebDir);
        // Fall through to start the dashboard on this port.
      }

      const webDir = localWebDir;

      console.log(chalk.bold(`Starting dashboard on http://localhost:${port}\n`));

      const lifecycleRuntime = await maybeStartLifecycle(config, opts.lifecycle !== false);

      const env = await buildDashboardEnv(
        port,
        config.configPath,
        config.terminalPort,
        config.directTerminalPort,
      );

      // Use web package's dev script so Next + terminal websocket servers start together.
      const child = spawn("pnpm", ["run", "dev"], {
        cwd: webDir,
        stdio: ["inherit", "inherit", "pipe"],
        env,
      });

      const stderrChunks: string[] = [];

      const MAX_STDERR_CHUNKS = 100;

      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        if (stderrChunks.length < MAX_STDERR_CHUNKS) {
          stderrChunks.push(text);
        }
        // Still show stderr to the user
        process.stderr.write(data);
      });

      child.on("error", (err) => {
        console.error(chalk.red("Could not start dashboard. Ensure Next.js is installed."));
        console.error(chalk.dim(String(err)));
        void lifecycleRuntime.cleanup().finally(() => {
          process.exit(1);
        });
      });

      let browserTimer: ReturnType<typeof setTimeout> | undefined;

      if (opts.open !== false) {
        browserTimer = setTimeout(() => {
          const browser = spawn("open", [`http://localhost:${port}`], {
            stdio: "ignore",
          });
          browser.on("error", () => {
            // Ignore — browser open is best-effort
          });
        }, 3000);
      }

      child.on("exit", (code) => {
        if (browserTimer) clearTimeout(browserTimer);

        if (code !== 0 && code !== null && !opts.rebuild) {
          const stderr = stderrChunks.join("");
          if (looksLikeStaleBuild(stderr)) {
            console.error(
              chalk.yellow(
                "\nThis looks like a stale build cache issue. Try:\n\n" +
                  `  ${chalk.cyan("ao dashboard --rebuild")}\n`,
              ),
            );
          }
        }

        void lifecycleRuntime.cleanup().finally(() => {
          process.exit(code ?? 0);
        });
      });
    });
}

interface LifecycleRuntimeState {
  cleanup: () => Promise<void>;
}

async function maybeStartLifecycle(
  config: OrchestratorConfig,
  enabled: boolean,
): Promise<LifecycleRuntimeState> {
  let lifecycleRunner: LifecycleRunner | null = null;
  let lifecycleLock: AcquiredLifecycleLock | null = null;

  const cleanup = async (): Promise<void> => {
    if (lifecycleRunner) {
      try {
        await lifecycleRunner.stop();
      } catch {
        // Best effort.
      }
      lifecycleRunner = null;
    }
    if (lifecycleLock) {
      releaseLifecycleLock(lifecycleLock);
      lifecycleLock = null;
    }
  };

  if (!enabled) {
    console.log(
      chalk.dim(
        "Lifecycle poller disabled (--no-lifecycle). Queue pickup and automation gates are inactive.",
      ),
    );
    return { cleanup };
  }

  if (!config.configPath) {
    console.log(
      chalk.yellow(
        "Skipping lifecycle poller startup because config path is unavailable in this runtime.",
      ),
    );
    return { cleanup };
  }

  const projectId = resolveSingleProjectId(config);
  if (!projectId) {
    console.log(
      chalk.yellow(
        "Skipping lifecycle poller startup: multiple projects configured. Use `ao start <project> --no-orchestrator`.",
      ),
    );
    return { cleanup };
  }

  const lockAttempt = tryAcquireLifecycleLock({
    configPath: config.configPath,
    projectId,
  });

  if (!lockAttempt.acquired || !lockAttempt.lock) {
    const pidHint = lockAttempt.existingPid ? ` (pid ${lockAttempt.existingPid})` : "";
    console.log(
      chalk.dim(
        `Lifecycle poller already running for project "${projectId}"${pidHint}; dashboard will reuse it.`,
      ),
    );
    return { cleanup };
  }

  lifecycleLock = lockAttempt.lock;
  lifecycleRunner = createLifecycleRunner({
    config,
    intervalMs: DEFAULT_LIFECYCLE_POLL_INTERVAL_MS,
  });

  try {
    await lifecycleRunner.start();
    console.log(
      chalk.dim(
        `Lifecycle poller started for "${projectId}" (every ${DEFAULT_LIFECYCLE_POLL_INTERVAL_MS / 1000}s).`,
      ),
    );
    if (lockAttempt.staleRecovered) {
      console.log(chalk.dim(`Recovered stale lifecycle lock at ${lockAttempt.lockPath}`));
    }
  } catch (err) {
    await cleanup();
    console.log(
      chalk.yellow(
        `Failed to start lifecycle poller: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  return { cleanup };
}

function resolveSingleProjectId(config: OrchestratorConfig): string | null {
  const projectIds = Object.keys(config.projects);
  if (projectIds.length !== 1) return null;
  return projectIds[0] ?? null;
}

/**
 * Check if stderr output suggests stale build artifacts.
 */
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
