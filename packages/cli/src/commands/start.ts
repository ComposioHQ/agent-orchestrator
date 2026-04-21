/**
 * `ao start` and `ao stop` commands — unified orchestrator startup.
 *
 * Supports two modes:
 *   1. `ao start [project]` — start from existing config
 *   2. `ao start <url>` — clone repo, auto-generate config, then start
 *
 * The orchestrator prompt is passed to the agent via --append-system-prompt
 * (or equivalent flag) at launch time — no file writing required.
 *
 * This file is a thin orchestrator — argument parsing + top-level flow only.
 * Implementation lives in focused `lib/` modules:
 *   - lib/clone-and-config.ts     URL clone + config bootstrap
 *   - lib/config-bootstrap.ts     auto-create / add-project config helpers
 *   - lib/dashboard-bootstrap.ts  dashboard start/stop + port management
 *   - lib/orchestrator-bootstrap.ts  shared startup (dashboard + lifecycle + session)
 *   - lib/agent-install-prompts.ts interactive runtime/agent selection
 *   - lib/installer.ts            shared "ensure git/tmux, offer to install" flow
 *   - lib/project-resolution.ts   resolve project id from arg / cwd / repo match
 */

import { resolve } from "node:path";
import { cwd } from "node:process";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  generateSessionPrefix,
  findConfigFile,
  isRepoUrl,
  isOrchestratorSession,
  isTerminalSession,
  ConfigNotFoundError,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@aoagents/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";
import { stopAllLifecycleWorkers } from "../lib/lifecycle-service.js";
import { openUrl } from "../lib/web-dir.js";
import {
  register,
  unregister,
  isAlreadyRunning,
  getRunning,
  waitForExit,
  acquireStartupLock,
} from "../lib/running-state.js";
import { isHumanCaller } from "../lib/caller-context.js";
import { promptSelect } from "../lib/prompts.js";
import {
  resolveProject,
  resolveProjectByRepo,
} from "../lib/project-resolution.js";
import { handleUrlStart } from "../lib/clone-and-config.js";
import {
  autoCreateConfig,
  addProjectToConfig,
  addDuplicateProjectToConfig,
  saveAgentOverride,
} from "../lib/config-bootstrap.js";
import { stopDashboard } from "../lib/dashboard-bootstrap.js";
import { runStartup } from "../lib/orchestrator-bootstrap.js";
import { promptAgentSelection } from "../lib/agent-install-prompts.js";
import { DEFAULT_PORT } from "../lib/constants.js";

/**
 * Create config without starting dashboard/orchestrator.
 * Used by deprecated `ao init` wrapper.
 */
export async function createConfigOnly(): Promise<void> {
  await autoCreateConfig(cwd());
}

/**
 * Check if arg looks like a local path (not a project ID).
 * Paths contain / or ~ or . at the start.
 */
function isLocalPath(arg: string): boolean {
  return arg.startsWith("/") || arg.startsWith("~") || arg.startsWith("./") || arg.startsWith("..");
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerStart(program: Command): void {
  program
    .command("start [project]")
    .description(
      "Start orchestrator agent and dashboard (auto-creates config on first run, adds projects by path/URL)",
    )
    .option("--no-dashboard", "Skip starting the dashboard server")
    .option("--no-orchestrator", "Skip starting the orchestrator agent")
    .option("--rebuild", "Clean and rebuild dashboard before starting")
    .option("--dev", "Use Next.js dev server with hot reload (for dashboard UI development)")
    .option("--interactive", "Prompt to configure config settings")
    .action(
      async (
        projectArg?: string,
        opts?: {
          dashboard?: boolean;
          orchestrator?: boolean;
          rebuild?: boolean;
          dev?: boolean;
          interactive?: boolean;
        },
      ) => {
        let releaseStartupLock: (() => void) | undefined;
        let startupLockReleased = false;
        const unlockStartup = (): void => {
          if (startupLockReleased || !releaseStartupLock) return;
          startupLockReleased = true;
          releaseStartupLock();
        };

        try {
          releaseStartupLock = await acquireStartupLock();
          let config: OrchestratorConfig;
          let projectId: string;
          let project: ProjectConfig;

          // ── Already-running detection (before any config mutation) ──
          const running = await isAlreadyRunning();
          let startNewOrchestrator = false;
          if (running) {
            if (isHumanCaller()) {
              console.log(chalk.cyan(`\nℹ AO is already running.`));
              console.log(`  Dashboard: ${chalk.cyan(`http://localhost:${running.port}`)}`);
              console.log(`  PID: ${running.pid} | Up since: ${running.startedAt}`);
              console.log(`  Projects: ${running.projects.join(", ")}\n`);

              const choice = await promptSelect(
                "AO is already running. What do you want to do?",
                [
                  { value: "open", label: "Open dashboard", hint: "Keep the current instance" },
                  { value: "new", label: "Start new orchestrator", hint: "Add a new session for this project" },
                  { value: "restart", label: "Restart everything", hint: "Stop the current instance first" },
                  { value: "quit", label: "Quit" },
                ],
                "open",
              );

              if (choice === "open") {
                const url = `http://localhost:${running.port}`;
                openUrl(url);
                unlockStartup();
                process.exit(0);
              } else if (choice === "new") {
                // Defer config mutation until after config is loaded below
                startNewOrchestrator = true;
              } else if (choice === "restart") {
                try { process.kill(running.pid, "SIGTERM"); } catch { /* already dead */ }
                if (!(await waitForExit(running.pid, 5000))) {
                  console.log(chalk.yellow("  Process didn't exit cleanly, sending SIGKILL..."));
                  try { process.kill(running.pid, "SIGKILL"); } catch { /* already dead */ }
                  if (!(await waitForExit(running.pid, 3000))) {
                    throw new Error(
                      `Failed to stop AO process (PID ${running.pid}). Check permissions or stop it manually.`,
                    );
                  }
                }
                await unregister();
                console.log(chalk.yellow("\n  Stopped existing instance. Restarting...\n"));
                // Continue to startup below
              } else {
                unlockStartup();
                process.exit(0);
              }
            } else {
              // Agent/non-TTY caller — print info and exit
              console.log(`AO is already running.`);
              console.log(`Dashboard: http://localhost:${running.port}`);
              console.log(`PID: ${running.pid}`);
              console.log(`Projects: ${running.projects.join(", ")}`);
              console.log(`To restart: ao stop && ao start`);
              unlockStartup();
              process.exit(0);
            }
          }

          if (projectArg && isRepoUrl(projectArg)) {
            // ── URL argument: clone + auto-config + start ──
            console.log(chalk.bold.cyan("\n  Agent Orchestrator — Quick Start\n"));
            const result = await handleUrlStart(projectArg);
            config = result.config;
            ({ projectId, project } = await resolveProjectByRepo(config, result.parsed));
          } else if (projectArg && isLocalPath(projectArg)) {
            // ── Path argument: add project if new, then start ──
            const resolvedPath = resolve(projectArg.replace(/^~/, process.env["HOME"] || ""));

            // Try to load existing config
            let configPath: string | undefined;
            try {
              configPath = findConfigFile() ?? undefined;
            } catch {
              // No config found — create one first
            }

            if (!configPath) {
              if (resolve(cwd()) !== resolvedPath) {
                // Target path differs from cwd — create config at the target repo
                config = await autoCreateConfig(resolvedPath);
              } else {
                // cwd is the target — auto-create config here
                config = await autoCreateConfig(cwd());
              }
              ({ projectId, project } = await resolveProject(config));
            } else {
              config = loadConfig(configPath);

              // Check if project is already in config (match by path)
              const existingEntry = Object.entries(config.projects).find(
                ([, p]) => resolve(p.path.replace(/^~/, process.env["HOME"] || "")) === resolvedPath,
              );

              if (existingEntry) {
                // Already in config — just start it
                projectId = existingEntry[0];
                project = existingEntry[1];
              } else {
                // New project — add it to config
                const addedId = await addProjectToConfig(config, resolvedPath);
                config = loadConfig(config.configPath);
                projectId = addedId;
                project = config.projects[projectId];
              }
            }
          } else {
            // ── No arg or project ID: load config or auto-create ──
            let loadedConfig: OrchestratorConfig | null = null;
            try {
              loadedConfig = loadConfig();
            } catch (err) {
              if (err instanceof ConfigNotFoundError) {
                // First run — auto-create config
                loadedConfig = await autoCreateConfig(cwd());
              } else {
                throw err;
              }
            }
            config = loadedConfig;
            ({ projectId, project } = await resolveProject(config, projectArg));
          }

          // ── Handle "new orchestrator" choice (deferred from already-running check) ──
          if (startNewOrchestrator) {
            const newId = addDuplicateProjectToConfig(config, projectId);
            config = loadConfig(config.configPath);
            projectId = newId;
            project = config.projects[newId];
          }

          // ── Agent selection prompt (Step 10)──
          const agentOverride = opts?.interactive ? await promptAgentSelection() : null;
          if (agentOverride) {
            saveAgentOverride(config.configPath, projectId, project.path, agentOverride);
            config = loadConfig(config.configPath);
            project = config.projects[projectId];
          }

          const actualPort = await runStartup(config, projectId, project, opts);

          // ── Register in running.json (Step 11) ──
          // Only record the project this invocation actually polls. Other
          // configured projects are not covered by this lifecycle loop, and
          // `ao spawn` relies on this list to decide whether to warn users.
          await register({
            pid: process.pid,
            configPath: config.configPath,
            port: actualPort,
            startedAt: new Date().toISOString(),
            projects: [projectId],
          });
          unlockStartup();

          // Install shutdown handlers so `ao stop` (which sends SIGTERM to
          // this pid) flushes lifecycle health state before exit. Handlers
          // MUST call process.exit() — installing a SIGINT/SIGTERM listener
          // removes Node's default exit behavior, so without an explicit
          // exit the interval timer would keep the event loop alive.
          let shuttingDown = false;
          const shutdown = (signal: NodeJS.Signals): void => {
            if (shuttingDown) return;
            shuttingDown = true;
            try {
              stopAllLifecycleWorkers();
            } catch {
              // Best-effort cleanup — never block shutdown on observability.
            }
            process.exit(signal === "SIGINT" ? 130 : 0);
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        } catch (err) {
          if (err instanceof Error) {
            console.error(chalk.red("\nError:"), err.message);
          } else {
            console.error(chalk.red("\nError:"), String(err));
          }
          unlockStartup();
          process.exit(1);
        } finally {
          unlockStartup();
        }
      },
    );
}

export function registerStop(program: Command): void {
  program
    .command("stop [project]")
    .description("Stop orchestrator agent and dashboard")
    .option("--purge-session", "Delete mapped OpenCode session when stopping")
    .option("--all", "Stop all running AO instances")
    .action(
      async (
        projectArg?: string,
        opts: { purgeSession?: boolean; all?: boolean } = {},
      ) => {
        try {
          // Check running.json first
          const running = await getRunning();

          if (opts.all) {
            // --all: kill via running.json if available, then fallback to config
            if (running) {
              try {
                process.kill(running.pid, "SIGTERM");
              } catch {
                // Already dead
              }
              await unregister();
              console.log(
                chalk.green(`\n✓ Stopped AO on port ${running.port}`),
              );
              console.log(chalk.dim(`  Projects: ${running.projects.join(", ")}\n`));
            } else {
              console.log(chalk.yellow("No running AO instance found in running.json."));
            }
            return;
          }

          const config = loadConfig();
          const { projectId: _projectId, project } = await resolveProject(config, projectArg, "stop");
          const port = config.port ?? DEFAULT_PORT;

          console.log(chalk.bold(`\nStopping orchestrator for ${chalk.cyan(project.name)}\n`));

          // Resolve the actual orchestrator session id by listing the project's sessions
          // and finding the most-recently-active orchestrator. This avoids relying on the
          // legacy `${prefix}-orchestrator` (no-N) phantom id, which never matches a real
          // numbered session and causes ao stop to silently no-op.
          const sm = await getSessionManager(config);
          const allSessionPrefixes = Object.entries(config.projects).map(
            ([, p]) => p.sessionPrefix ?? generateSessionPrefix(p.name ?? ""),
          );
          let orchestratorToKill: { id: string } | null = null;
          let lookupFailed = false;
          try {
            const projectSessions = await sm.list(_projectId);
            const orchestrators = projectSessions
              .filter((s) =>
                isOrchestratorSession(s, project.sessionPrefix ?? _projectId, allSessionPrefixes),
              )
              .filter((s) => !isTerminalSession(s));
            const sorted = [...orchestrators].sort(
              (a, b) =>
                (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0),
            );
            orchestratorToKill = sorted[0] ?? null;
          } catch (err) {
            lookupFailed = true;
            console.log(
              chalk.yellow(
                `  Could not list sessions to locate orchestrator: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
          }

          if (orchestratorToKill) {
            const spinner = ora("Stopping orchestrator session").start();
            const purgeOpenCode = opts?.purgeSession === true;
            await sm.kill(orchestratorToKill.id, { purgeOpenCode });
            spinner.succeed(`Orchestrator session stopped (${orchestratorToKill.id})`);
            // Also log to console.log so the killed id is visible in non-TTY callers
            // (CI, scripts) and in test capture, since spinner output is suppressed.
            console.log(chalk.green(`  Stopped orchestrator session: ${orchestratorToKill.id}`));
          } else if (!lookupFailed) {
            // Suppress the "no orchestrator found" message when sm.list threw —
            // the catch above already explained the real reason and adding a
            // second message would falsely imply the lookup succeeded.
            console.log(
              chalk.yellow(`No running orchestrator session found for "${project.name}"`),
            );
          }

          // Lifecycle polling runs in-process inside the `ao start` process
          // (registered via `running.json`). Sending SIGTERM to that PID below
          // triggers the shared shutdown handler in `lifecycle-service`, which
          // stops every per-project loop. No explicit stop call needed here —
          // this CLI invocation is a separate process with an empty active map.

          // Stop dashboard — kill parent PID from running.json, then also stop
          // any dashboard child process via lsof (parent SIGTERM may not propagate)
          if (running) {
            try {
              process.kill(running.pid, "SIGTERM");
            } catch {
              // Already dead
            }
            await unregister();
          }
          await stopDashboard(running?.port ?? port);

          console.log(chalk.bold.green("\n✓ Orchestrator stopped\n"));
          console.log(
            chalk.dim(`  Uptime: since ${running?.startedAt ?? "unknown"}`),
          );
          console.log(
            chalk.dim(`  Projects: ${Object.keys(config.projects).join(", ")}\n`),
          );
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
