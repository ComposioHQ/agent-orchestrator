/**
 * `ao start` and `ao stop` commands — unified orchestrator startup.
 *
 * Starts both the dashboard and the orchestrator agent session, generating
 * CLAUDE.orchestrator.md and injecting it via CLAUDE.local.md import.
 */

import { type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  generateOrchestratorPrompt,
  hasTmuxSession,
  newTmuxSession,
  tmuxSendKeys,
  writeMetadata,
  readMetadata,
  deleteMetadata,
  getSessionsDir,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@composio/ao-core";
import { exec, getTmuxSessions } from "../lib/shell.js";
import { getAgent } from "../lib/plugins.js";
import { getConfig, getConfigPath } from "../services/ConfigService.js";
import { PortManager } from "../services/PortManager.js";
import { DashboardManager } from "../services/DashboardManager.js";

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
          const configPath = getConfigPath();
          if (!configPath) {
            throw new Error("No agent-orchestrator.yaml found. Run `ao init` to create one.");
          }

          const config = getConfig(configPath);
          const { projectId, project } = resolveProject(config, projectArg);
          const sessionId = `${project.sessionPrefix}-orchestrator`;

          // Allocate ports for all services
          const portManager = new PortManager();
          const ports = await portManager.allocateServicePorts(config.port ?? 3000);

          if (ports.dashboard !== (config.port ?? 3000)) {
            console.log(
              chalk.yellow(`Port ${config.port ?? 3000} in use, using ${ports.dashboard} instead`),
            );
          }

          console.log(chalk.bold(`\nStarting orchestrator for ${chalk.cyan(project.name)}\n`));

          // Start dashboard (unless --no-dashboard)
          const spinner = ora();
          let dashboardProcess: ChildProcess | null = null;
          let exists = false; // Track whether orchestrator session already exists
          const dashboardManager = new DashboardManager();

          if (opts?.dashboard !== false) {
            spinner.start("Starting dashboard");

            try {
              dashboardProcess = dashboardManager.start({
                ports,
                configPath,
              });
              spinner.succeed(`Dashboard starting on http://localhost:${ports.dashboard}`);
              console.log(chalk.dim("  (Dashboard will be ready in a few seconds)\n"));
            } catch (err) {
              spinner.fail("Dashboard not found");
              throw err;
            }
          }

          // Create orchestrator tmux session (unless --no-orchestrator or already exists)
          if (opts?.orchestrator !== false) {
            const sessionsDir = getSessionsDir(config.configPath, project.path);

            // Check if orchestrator session already exists
            exists = await hasTmuxSession(sessionId);

            if (exists) {
              console.log(
                chalk.yellow(
                  `Orchestrator session "${sessionId}" is already running (skipping creation)`,
                ),
              );

              // Update metadata with current dashboard port
              const existingMetadata = readMetadata(sessionsDir, sessionId);
              if (existingMetadata) {
                writeMetadata(sessionsDir, sessionId, {
                  ...existingMetadata,
                  dashboardPort: ports.dashboard,
                });
              }
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
                  await agent.setupWorkspaceHooks(project.path, { dataDir: sessionsDir });
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
                  AO_DATA_DIR: sessionsDir,
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

                  writeMetadata(sessionsDir, sessionId, {
                    worktree: project.path,
                    branch: project.defaultBranch,
                    status: "working",
                    project: projectId,
                    createdAt: new Date().toISOString(),
                    runtimeHandle,
                    dashboardPort: ports.dashboard,
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
            console.log(chalk.cyan("Dashboard:"), `http://localhost:${ports.dashboard}`);
          }

          if (opts?.orchestrator !== false && !exists) {
            console.log(chalk.cyan("Orchestrator:"), `tmux attach -t ${sessionId}`);
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
        const config = getConfig();
        const { projectId: _projectId, project } = resolveProject(config, projectArg);
        const sessionId = `${project.sessionPrefix}-orchestrator`;
        const sessionsDir = getSessionsDir(config.configPath, project.path);

        // Read port from metadata (actual port used), fallback to config default
        const metadata = readMetadata(sessionsDir, sessionId);
        const dashboardPort = metadata?.dashboardPort
          ? Number(metadata.dashboardPort)
          : (config.port ?? 3000);

        // WebSocket ports use fixed defaults (not stored in metadata)
        const terminalWsPort = 3001;
        const directTerminalWsPort = 3003;

        console.log(chalk.bold(`\nStopping orchestrator for ${chalk.cyan(project.name)}\n`));

        // Kill orchestrator session
        const sessions = await getTmuxSessions();
        if (sessions.includes(sessionId)) {
          const spinner = ora("Stopping orchestrator session").start();
          await exec("tmux", ["kill-session", "-t", sessionId]);
          spinner.succeed("Orchestrator session stopped");

          // Archive metadata
          deleteMetadata(sessionsDir, sessionId, true);
        } else {
          console.log(chalk.yellow(`Orchestrator session "${sessionId}" is not running`));
        }

        // Stop dashboard and WebSocket servers
        const dashboardManager = new DashboardManager();
        await dashboardManager.stop({
          dashboard: dashboardPort,
          terminalWs: terminalWsPort,
          directTerminalWs: directTerminalWsPort,
        });
        console.log(chalk.green("Dashboard stopped"));

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
