/**
 * `ao start` and `ao stop` commands — unified orchestrator startup.
 *
 * Starts both the dashboard and the orchestrator agent session, generating
 * CLAUDE.orchestrator.md and injecting it via CLAUDE.local.md import.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  generateOrchestratorPrompt,
  hasTmuxSession,
  newTmuxSession,
  tmuxSendKeys,
  writeMetadata,
  deleteMetadata,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@composio/ao-core";
import { exec, getTmuxSessions } from "../lib/shell.js";
import { getAgent } from "../lib/plugins.js";
import { findWebDir } from "../lib/web-dir.js";

/**
 * Ensure CLAUDE.orchestrator.md exists in the project directory.
 * Generate it if missing or if --regenerate flag is set.
 */
function ensureOrchestratorPrompt(
  projectPath: string,
  config: OrchestratorConfig,
  projectId: string,
  project: ProjectConfig,
  regenerate = false,
): void {
  const promptPath = join(projectPath, "CLAUDE.orchestrator.md");

  if (existsSync(promptPath) && !regenerate) {
    return; // Already exists and not regenerating
  }

  const content = generateOrchestratorPrompt({ config, projectId, project });
  writeFileSync(promptPath, content, "utf-8");
}

/**
 * Ensure CLAUDE.local.md imports CLAUDE.orchestrator.md.
 * This function is idempotent — multiple calls have no additional effect.
 */
function ensureOrchestratorImport(projectPath: string): void {
  const localMdPath = join(projectPath, "CLAUDE.local.md");
  const importLine = "@CLAUDE.orchestrator.md";

  let content = "";
  if (existsSync(localMdPath)) {
    content = readFileSync(localMdPath, "utf-8");
  }

  // Check if import already exists
  if (content.includes(importLine)) {
    return; // Already imported
  }

  // Append import
  if (content && !content.endsWith("\n")) {
    content += "\n";
  }
  if (content) {
    content += "\n"; // Blank line separator
  }
  content += `${importLine}\n`;

  writeFileSync(localMdPath, content, "utf-8");
}

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
 * Start dashboard server in the background.
 * Returns the child process handle for cleanup.
 */
function startDashboard(port: number, webDir: string): ChildProcess {
  const child = spawn("npx", ["next", "dev", "-p", String(port)], {
    cwd: webDir,
    stdio: "inherit",
    detached: false,
  });

  child.on("error", (err) => {
    console.error(chalk.red("Dashboard failed to start:"), err);
  });

  return child;
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

export function registerStart(program: Command): void {
  program
    .command("start [project]")
    .description("Start orchestrator agent and dashboard for a project")
    .option("--no-dashboard", "Skip starting the dashboard server")
    .option("--no-orchestrator", "Skip starting the orchestrator agent")
    .option("--regenerate", "Regenerate CLAUDE.orchestrator.md")
    .action(
      async (
        projectArg?: string,
        opts?: { dashboard?: boolean; orchestrator?: boolean; regenerate?: boolean },
      ) => {
        try {
          const config = loadConfig();
          const { projectId, project } = resolveProject(config, projectArg);
          const sessionId = `${project.sessionPrefix || projectId}-orchestrator`;
          const port = config.port;

          console.log(chalk.bold(`\nStarting orchestrator for ${chalk.cyan(project.name)}\n`));

          // Start dashboard (unless --no-dashboard)
          const spinner = ora();
          let dashboardProcess: ChildProcess | null = null;
          let exists = false; // Track whether orchestrator session already exists

          if (opts?.dashboard !== false) {
            spinner.start("Starting dashboard");
            const webDir = findWebDir();
            if (!existsSync(resolve(webDir, "package.json"))) {
              spinner.fail("Dashboard not found");
              throw new Error("Could not find @composio/ao-web package. Run: pnpm install");
            }

            dashboardProcess = startDashboard(port, webDir);
            spinner.succeed(`Dashboard starting on http://localhost:${port}`);
            console.log(chalk.dim("  (Dashboard will be ready in a few seconds)\n"));
          }

          // Create orchestrator tmux session (unless --no-orchestrator or already exists)
          if (opts?.orchestrator !== false) {
            // Check if orchestrator session already exists
            exists = await hasTmuxSession(sessionId);

            // Migration: Check for legacy "undefined-orchestrator" session
            const legacySessionId = "undefined-orchestrator";
            const legacyExists = await hasTmuxSession(legacySessionId);

            if (legacyExists && !exists) {
              console.log(
                chalk.yellow(
                  `\nFound legacy orchestrator session "${legacySessionId}"`,
                ),
              );
              console.log(
                chalk.yellow(
                  `Stopping legacy session and creating new session "${sessionId}"...\n`,
                ),
              );

              // Stop legacy session
              try {
                await exec("tmux", ["kill-session", "-t", legacySessionId]);
                // Archive legacy metadata if it exists
                deleteMetadata(config.dataDir, legacySessionId, true);
                console.log(chalk.green(`✓ Legacy session stopped\n`));
              } catch (err) {
                console.log(
                  chalk.yellow(
                    `Warning: Could not stop legacy session: ${err instanceof Error ? err.message : String(err)}\n`,
                  ),
                );
              }
            }

            if (exists) {
              console.log(
                chalk.yellow(
                  `Orchestrator session "${sessionId}" is already running (skipping creation)`,
                ),
              );
            } else {
              try {
                // Ensure CLAUDE.orchestrator.md exists
                spinner.start("Generating orchestrator prompt");
                ensureOrchestratorPrompt(
                  project.path,
                  config,
                  projectId,
                  project,
                  opts?.regenerate ?? false,
                );
                spinner.succeed("Orchestrator prompt ready");

                // Ensure CLAUDE.local.md imports CLAUDE.orchestrator.md
                spinner.start("Configuring CLAUDE.local.md");
                ensureOrchestratorImport(project.path);
                spinner.succeed("CLAUDE.local.md configured");

                // Get agent instance (used for hooks and launch)
                const agent = getAgent(config, projectId);

                // Setup agent hooks for automatic metadata updates
                spinner.start("Configuring agent hooks");
                if (agent.setupWorkspaceHooks) {
                  await agent.setupWorkspaceHooks(project.path, { dataDir: config.dataDir });
                }
                spinner.succeed("Agent hooks configured");

                spinner.start("Creating orchestrator session");

                // Get agent launch command
                const launchCmd = agent.getLaunchCommand({
                  sessionId,
                  projectConfig: project,
                  permissions: project.agentConfig?.permissions ?? "default",
                  model: project.agentConfig?.model,
                });

                // Determine environment variables
                const envVarName = `${project.sessionPrefix.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_SESSION`;
                const environment: Record<string, string> = {
                  [envVarName]: sessionId,
                  AO_SESSION: sessionId,
                  AO_DATA_DIR: config.dataDir,
                  DIRENV_LOG_FORMAT: "",
                };

                // Merge agent-specific environment
                const agentEnv = agent.getEnvironment({
                  sessionId,
                  projectConfig: project,
                  permissions: project.agentConfig?.permissions ?? "default",
                  model: project.agentConfig?.model,
                });
                Object.assign(environment, agentEnv);

                // NOTE: AO_PROJECT_ID is intentionally not set for orchestrator (uses flat metadata path)

                // Create tmux session
                await newTmuxSession({
                  name: sessionId,
                  cwd: project.path,
                  environment,
                });

                try {
                  // Launch agent
                  await tmuxSendKeys(sessionId, launchCmd, true);

                  spinner.succeed("Orchestrator session created");

                  // Write metadata
                  const runtimeHandle = JSON.stringify({
                    id: sessionId,
                    runtimeName: "tmux",
                    data: {},
                  });

                  writeMetadata(config.dataDir, sessionId, {
                    worktree: project.path,
                    branch: project.defaultBranch,
                    status: "working",
                    project: projectId,
                    createdAt: new Date().toISOString(),
                    runtimeHandle,
                  });
                } catch (err) {
                  // Cleanup tmux session if metadata write or agent launch fails
                  try {
                    await exec("tmux", ["kill-session", "-t", sessionId]);
                  } catch {
                    // Best effort cleanup - session may not exist
                  }
                  throw err;
                }
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
            console.log(chalk.cyan("Orchestrator:"), `tmux attach -t ${sessionId}`);
          } else if (exists) {
            console.log(chalk.cyan("Orchestrator:"), `already running (${sessionId})`);
          }

          console.log(chalk.dim(`Config: ${config.dataDir}\n`));

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
        const { projectId, project } = resolveProject(config, projectArg);
        const sessionId = `${project.sessionPrefix || projectId}-orchestrator`;
        const port = config.port;

        console.log(chalk.bold(`\nStopping orchestrator for ${chalk.cyan(project.name)}\n`));

        // Kill orchestrator session (check both new and legacy names)
        const sessions = await getTmuxSessions();
        const legacySessionId = "undefined-orchestrator";
        let stopped = false;

        if (sessions.includes(sessionId)) {
          const spinner = ora("Stopping orchestrator session").start();
          await exec("tmux", ["kill-session", "-t", sessionId]);
          spinner.succeed("Orchestrator session stopped");

          // Archive metadata
          deleteMetadata(config.dataDir, sessionId, true);
          stopped = true;
        } else if (sessions.includes(legacySessionId)) {
          // Migration: Stop legacy session if it exists
          console.log(chalk.yellow(`Found legacy session "${legacySessionId}"`));
          const spinner = ora("Stopping legacy orchestrator session").start();
          await exec("tmux", ["kill-session", "-t", legacySessionId]);
          spinner.succeed("Legacy orchestrator session stopped");

          // Archive metadata
          deleteMetadata(config.dataDir, legacySessionId, true);
          stopped = true;
        }

        if (!stopped) {
          console.log(
            chalk.yellow(
              `Orchestrator session "${sessionId}" is not running\n` +
                chalk.dim(`(Also checked for legacy session "${legacySessionId}")`),
            ),
          );
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
    });
}
