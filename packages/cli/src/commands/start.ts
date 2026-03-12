/**
 * `ao start` and `ao stop` commands — unified orchestrator startup.
 *
 * Supports two modes:
 *   1. `ao start [project]` — start from existing config
 *   2. `ao start <url>` — clone repo, auto-generate config, then start
 *
 * The orchestrator prompt is passed to the agent via --append-system-prompt
 * (or equivalent flag) at launch time — no file writing required.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  generateOrchestratorPrompt,
  isRepoUrl,
  parseRepoUrl,
  resolveCloneTarget,
  isRepoAlreadyCloned,
  generateConfigFromUrl,
  configToYaml,
  normalizeOrchestratorSessionStrategy,
  type OrchestratorConfig,
  type ProjectConfig,
  type ParsedRepoUrl,
} from "@composio/ao-core";
import { exec, execSilent } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker, stopLifecycleWorker } from "../lib/lifecycle-service.js";
import {
  findWebDir,
  buildDashboardEnv,
  waitForPortAndOpen,
  isPortAvailable,
  findFreePort,
  MAX_PORT_SCAN,
} from "../lib/web-dir.js";
import { cleanNextCache } from "../lib/dashboard-rebuild.js";
import { preflight } from "../lib/preflight.js";

const DEFAULT_PORT = 3000;

// =============================================================================
// HELPERS
// =============================================================================

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
 * Resolve project from config by matching against a repo URL's ownerRepo.
 * Used when `ao start <url>` loads an existing multi-project config — the user
 * can't pass both a URL and a project name since they share the same arg slot.
 *
 * Falls back to `resolveProject` (which handles single-project configs or
 * errors with a helpful message for ambiguous multi-project cases).
 */
function resolveProjectByRepo(
  config: OrchestratorConfig,
  parsed: ParsedRepoUrl,
): { projectId: string; project: ProjectConfig } {
  const projectIds = Object.keys(config.projects);

  // Try to match by repo field (e.g. "owner/repo")
  for (const id of projectIds) {
    const project = config.projects[id];
    if (project.repo === parsed.ownerRepo) {
      return { projectId: id, project };
    }
  }

  // No repo match — fall back to standard resolution (works for single-project)
  return resolveProject(config);
}

/**
 * Clone a repo with authentication support.
 *
 * Strategy:
 *   1. Try `gh repo clone owner/repo target -- --depth 1` — handles GitHub auth
 *      for private repos via the user's `gh auth` token.
 *   2. Fall back to `git clone --depth 1` with SSH URL — works for users with
 *      SSH keys configured (common for private repos without gh).
 *   3. Final fallback to `git clone --depth 1` with HTTPS URL — works for
 *      public repos without any auth setup.
 */
async function cloneRepo(parsed: ParsedRepoUrl, targetDir: string, cwd: string): Promise<void> {
  // 1. Try gh repo clone (handles GitHub auth automatically)
  if (parsed.host === "github.com") {
    const ghAvailable = (await execSilent("gh", ["auth", "status"])) !== null;
    if (ghAvailable) {
      try {
        await exec("gh", ["repo", "clone", parsed.ownerRepo, targetDir, "--", "--depth", "1"], {
          cwd,
        });
        return;
      } catch {
        // gh clone failed — fall through to git clone with SSH
      }
    }
  }

  // 2. Try git clone with SSH URL (works with SSH keys for private repos)
  const sshUrl = `git@${parsed.host}:${parsed.ownerRepo}.git`;
  try {
    await exec("git", ["clone", "--depth", "1", sshUrl, targetDir], { cwd });
    return;
  } catch {
    // SSH failed — fall through to HTTPS
  }

  // 3. Final fallback: HTTPS (works for public repos)
  await exec("git", ["clone", "--depth", "1", parsed.cloneUrl, targetDir], { cwd });
}

/**
 * Handle `ao start <url>` — clone repo, generate config, return loaded config.
 * Also returns the parsed URL so the caller can match by repo when the config
 * contains multiple projects.
 */
async function handleUrlStart(
  url: string,
): Promise<{ config: OrchestratorConfig; parsed: ParsedRepoUrl; autoGenerated: boolean }> {
  const spinner = ora();

  // 1. Parse URL
  spinner.start("Parsing repository URL");
  const parsed = parseRepoUrl(url);
  spinner.succeed(`Repository: ${chalk.cyan(parsed.ownerRepo)} (${parsed.host})`);

  // 2. Determine target directory
  const cwd = process.cwd();
  const targetDir = resolveCloneTarget(parsed, cwd);
  const alreadyCloned = isRepoAlreadyCloned(targetDir, parsed.cloneUrl);

  // 3. Clone or reuse
  if (alreadyCloned) {
    console.log(chalk.green(`  Reusing existing clone at ${targetDir}`));
  } else {
    spinner.start(`Cloning ${parsed.ownerRepo}`);
    try {
      await cloneRepo(parsed, targetDir, cwd);
      spinner.succeed(`Cloned to ${targetDir}`);
    } catch (err) {
      spinner.fail("Clone failed");
      throw new Error(
        `Failed to clone ${parsed.ownerRepo}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // 4. Check for existing config
  const configPath = resolve(targetDir, "agent-orchestrator.yaml");
  const configPathAlt = resolve(targetDir, "agent-orchestrator.yml");

  if (existsSync(configPath)) {
    console.log(chalk.green(`  Using existing config: ${configPath}`));
    return { config: loadConfig(configPath), parsed, autoGenerated: false };
  }

  if (existsSync(configPathAlt)) {
    console.log(chalk.green(`  Using existing config: ${configPathAlt}`));
    return { config: loadConfig(configPathAlt), parsed, autoGenerated: false };
  }

  // 5. Auto-generate config with a free port
  spinner.start("Generating config");
  const freePort = await findFreePort(DEFAULT_PORT);
  const rawConfig = generateConfigFromUrl({
    parsed,
    repoPath: targetDir,
    port: freePort ?? DEFAULT_PORT,
  });

  const yamlContent = configToYaml(rawConfig);
  writeFileSync(configPath, yamlContent);
  spinner.succeed(`Config generated: ${configPath}`);

  return { config: loadConfig(configPath), parsed, autoGenerated: true };
}

/**
 * Start dashboard server in the background.
 * Returns the child process handle for cleanup.
 */
async function startDashboard(
  port: number,
  webDir: string,
  configPath: string | null,
  terminalPort?: number,
  directTerminalPort?: number,
): Promise<ChildProcess> {
  const env = await buildDashboardEnv(port, configPath, terminalPort, directTerminalPort);

  const child = spawn("pnpm", ["run", "dev"], {
    cwd: webDir,
    stdio: "inherit",
    detached: false,
    env,
  });

  child.on("error", (err) => {
    console.error(chalk.red("Dashboard failed to start:"), err.message);
    // Emit synthetic exit so callers listening on "exit" can clean up
    child.emit("exit", 1, null);
  });

  return child;
}

/**
 * Shared startup logic: launch dashboard + orchestrator session, print summary.
 * Used by both normal and URL-based start flows.
 */
async function runStartup(
  config: OrchestratorConfig,
  projectId: string,
  project: ProjectConfig,
  opts?: { dashboard?: boolean; orchestrator?: boolean; rebuild?: boolean; autoPort?: boolean },
): Promise<void> {
  const sessionId = `${project.sessionPrefix}-orchestrator`;
  const shouldStartLifecycle = opts?.dashboard !== false || opts?.orchestrator !== false;
  let lifecycleStatus: Awaited<ReturnType<typeof ensureLifecycleWorker>> | null = null;
  let port = config.port ?? DEFAULT_PORT;
  const orchestratorSessionStrategy = normalizeOrchestratorSessionStrategy(
    project.orchestratorSessionStrategy,
  );

  console.log(chalk.bold(`\nStarting orchestrator for ${chalk.cyan(project.name)}\n`));

  const spinner = ora();
  let dashboardProcess: ChildProcess | null = null;
  let reused = false;

  // Start dashboard (unless --no-dashboard)
  if (opts?.dashboard !== false) {
    if (opts?.autoPort) {
      // Port was auto-selected during config generation — if it's now busy
      // (race condition), find another free port instead of erroring.
      if (!(await isPortAvailable(port))) {
        const newPort = await findFreePort(DEFAULT_PORT);
        if (newPort === null) {
          throw new Error(
            `No free port found in range ${DEFAULT_PORT}–${DEFAULT_PORT + MAX_PORT_SCAN - 1}.`,
          );
        }
        port = newPort;
      }
    } else {
      await preflight.checkPort(port);
    }
    const webDir = findWebDir();
    if (!existsSync(resolve(webDir, "package.json"))) {
      throw new Error("Could not find @composio/ao-web package. Run: pnpm install");
    }
    await preflight.checkBuilt(webDir);

    if (opts?.rebuild) {
      await cleanNextCache(webDir);
    }

    spinner.start("Starting dashboard");
    dashboardProcess = await startDashboard(
      port,
      webDir,
      config.configPath,
      config.terminalPort,
      config.directTerminalPort,
    );
    spinner.succeed(`Dashboard starting on http://localhost:${port}`);
    console.log(chalk.dim("  (Dashboard will be ready in a few seconds)\n"));
  }

  if (shouldStartLifecycle) {
    try {
      spinner.start("Starting lifecycle worker");
      lifecycleStatus = await ensureLifecycleWorker(config, projectId);
      spinner.succeed(
        lifecycleStatus.started
          ? `Lifecycle worker started${lifecycleStatus.pid ? ` (PID ${lifecycleStatus.pid})` : ""}`
          : `Lifecycle worker already running${lifecycleStatus.pid ? ` (PID ${lifecycleStatus.pid})` : ""}`,
      );
    } catch (err) {
      spinner.fail("Lifecycle worker failed to start");
      if (dashboardProcess) {
        dashboardProcess.kill();
      }
      throw new Error(
        `Failed to start lifecycle worker: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // Create orchestrator session (unless --no-orchestrator or already exists)
  let tmuxTarget = sessionId;
  if (opts?.orchestrator !== false) {
    const sm = await getSessionManager(config);

    try {
      spinner.start("Creating orchestrator session");
      const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
      const session = await sm.spawnOrchestrator({ projectId, systemPrompt });
      if (session.runtimeHandle?.id) {
        tmuxTarget = session.runtimeHandle.id;
      }
      reused =
        orchestratorSessionStrategy === "reuse" &&
        session.metadata?.["orchestratorSessionReused"] === "true";
      spinner.succeed(reused ? "Orchestrator session reused" : "Orchestrator session created");
    } catch (err) {
      spinner.fail("Orchestrator setup failed");
      if (dashboardProcess) {
        dashboardProcess.kill();
      }
      throw new Error(
        `Failed to setup orchestrator: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  process.on("SIGINT", () => {
    if (dashboardProcess) dashboardProcess.kill();
    process.exit(0);
  });

  // Print summary
  console.log(chalk.bold.green("\n✓ Startup complete\n"));

  if (opts?.dashboard !== false) {
    console.log(chalk.cyan("Dashboard:"), `http://localhost:${port}`);
  }

  if (shouldStartLifecycle && lifecycleStatus) {
    const lifecycleLabel = lifecycleStatus.started ? "started" : "already running";
    const lifecycleTarget = lifecycleStatus.pid
      ? `${lifecycleLabel} (PID ${lifecycleStatus.pid})`
      : lifecycleLabel;
    console.log(chalk.cyan("Lifecycle:"), lifecycleTarget);
  }

  if (opts?.orchestrator !== false && !reused) {
    console.log(chalk.cyan("Orchestrator:"), `tmux attach -t ${tmuxTarget}`);
  } else if (reused) {
    console.log(chalk.cyan("Orchestrator:"), `reused existing session (${sessionId})`);
  }

  console.log(chalk.dim(`Config: ${config.configPath}\n`));

  // Auto-open browser to orchestrator session page once the server is accepting connections.
  // Polls the port instead of using a fixed delay — deterministic and works regardless of
  // how long Next.js takes to compile. AbortController cancels polling on early exit.
  let openAbort: AbortController | undefined;
  if (opts?.dashboard !== false) {
    openAbort = new AbortController();
    const orchestratorUrl = `http://localhost:${port}/sessions/${sessionId}`;
    void waitForPortAndOpen(port, orchestratorUrl, openAbort.signal);
  }

  // Keep dashboard process alive if it was started
  if (dashboardProcess) {
    dashboardProcess.on("exit", (code) => {
      if (openAbort) openAbort.abort();
      if (code !== 0 && code !== null) {
        console.error(chalk.red(`Dashboard exited with code ${code}`));
      }
      process.exit(code ?? 0);
    });
  }
}

/**
 * Stop dashboard server.
 * Uses lsof to find the process listening on the port, then kills it.
 * Best effort — if it fails, just warn the user.
 */
async function stopDashboard(port: number): Promise<void> {
  try {
    // Find PIDs listening on the port (can be multiple: parent + children)
    const { stdout } = await exec("lsof", ["-ti", `:${port}`]);
    const pids = stdout
      .trim()
      .split("\n")
      .filter((p) => p.length > 0);

    if (pids.length > 0) {
      // Kill all processes (pass PIDs as separate arguments)
      await exec("kill", pids);
      console.log(chalk.green("Dashboard stopped"));
    } else {
      console.log(chalk.yellow(`Dashboard not running on port ${port}`));
    }
  } catch {
    console.log(chalk.yellow("Could not stop dashboard (may not be running)"));
  }
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerStart(program: Command): void {
  program
    .command("start [project]")
    .description(
      "Start orchestrator agent and dashboard for a project (or pass a repo URL to onboard)",
    )
    .option("--no-dashboard", "Skip starting the dashboard server")
    .option("--no-orchestrator", "Skip starting the orchestrator agent")
    .option("--rebuild", "Clean and rebuild dashboard before starting")
    .action(
      async (
        projectArg?: string,
        opts?: {
          dashboard?: boolean;
          orchestrator?: boolean;
          rebuild?: boolean;
        },
      ) => {
        try {
          let config: OrchestratorConfig;
          let projectId: string;
          let project: ProjectConfig;
          let autoPort = false;

          // Detect URL argument — run onboarding flow
          if (projectArg && isRepoUrl(projectArg)) {
            console.log(chalk.bold.cyan("\n  Agent Orchestrator — Quick Start\n"));
            const result = await handleUrlStart(projectArg);
            config = result.config;
            autoPort = result.autoGenerated;
            ({ projectId, project } = resolveProjectByRepo(config, result.parsed));
          } else {
            // Normal flow — load existing config
            config = loadConfig();
            ({ projectId, project } = resolveProject(config, projectArg));
          }

          await runStartup(config, projectId, project, { ...opts, autoPort });
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
    .option("--keep-session", "Keep mapped OpenCode session after stopping")
    .option("--purge-session", "Delete mapped OpenCode session when stopping")
    .action(
      async (projectArg?: string, opts: { keepSession?: boolean; purgeSession?: boolean } = {}) => {
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
            const purgeOpenCode = opts.purgeSession === true ? true : opts.keepSession !== true;
            await sm.kill(sessionId, { purgeOpenCode });
            spinner.succeed("Orchestrator session stopped");
          } else {
            console.log(chalk.yellow(`Orchestrator session "${sessionId}" is not running`));
          }

          const lifecycleStopped = await stopLifecycleWorker(config, _projectId);
          if (lifecycleStopped) {
            console.log(chalk.green("Lifecycle worker stopped"));
          } else {
            console.log(chalk.yellow("Lifecycle worker not running"));
          }

          // Stop dashboard
          await stopDashboard(port);

          console.log(chalk.bold.green("\n✓ Orchestrator stopped\n"));
        } catch (err) {
          if (err instanceof Error) {
            console.error(chalk.red("\nError:"), err.message);
          } else {
            console.error(chalk.red("\nError:"), String(err));
          }
          process.exit(1);
        }
      },
    );
}
