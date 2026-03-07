/**
 * CLI commands for ao-teams — team-based agent orchestration.
 *
 * Commands:
 *   ao team spawn <project> [issue] --team <preset>  — Spawn a coordinated team
 *   ao team status                                    — Show team statuses
 *   ao team stop <worktree>                           — Stop a running team
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  resolveTeam,
  loadTeamsConfig,
  findConfigFile,
  createPluginRegistry,
  type OrchestratorConfig,
  type Runtime,
  type Agent,
  type Workspace,
  type TestTaskConfig,
} from "@composio/ao-core";
import { preflight } from "../lib/preflight.js";

/**
 * Resolve plugins for a team spawn via the plugin registry.
 */
async function resolveTeamPlugins(
  config: OrchestratorConfig,
  projectId: string,
): Promise<{
  runtime: Runtime;
  agent: Agent;
  workspace: Workspace | undefined;
}> {
  const registry = createPluginRegistry();
  await registry.loadFromConfig(config, (pkg: string) => import(pkg));

  const project = config.projects[projectId];
  const runtimeName = project.runtime ?? config.defaults.runtime;
  const agentName = project.agent ?? config.defaults.agent;
  const workspaceName = project.workspace ?? config.defaults.workspace;

  const runtime = registry.get<Runtime>("runtime", runtimeName);
  const agent = registry.get<Agent>("agent", agentName);
  const workspace = workspaceName ? registry.get<Workspace>("workspace", workspaceName) ?? undefined : undefined;

  if (!runtime) throw new Error(`Runtime plugin '${runtimeName}' not found`);
  if (!agent) throw new Error(`Agent plugin '${agentName}' not found`);

  return { runtime, agent, workspace };
}

/**
 * Register the `ao team` subcommand group.
 */
export function registerTeam(program: Command): void {
  const team = program
    .command("team")
    .description("Team-based agent orchestration (ao-teams)");

  // --- ao team spawn ---
  team
    .command("spawn")
    .description("Spawn a coordinated team of agents")
    .argument("<project>", "Project ID from config")
    .argument("[issue]", "Issue identifier (e.g. #42, INT-1234)")
    .option("--team <preset>", "Team preset (solo, pair, quad) or custom team name", "pair")
    .option("--branch <name>", "Branch name override")
    .option("--yes", "Skip confirmation prompt")
    .action(
      async (
        projectId: string,
        issueId: string | undefined,
        opts: {
          team: string;
          branch?: string;
          yes?: boolean;
        },
      ) => {
        const config = loadConfig();
        const project = config.projects[projectId];

        if (!project) {
          console.error(
            chalk.red(
              `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }

        // Load teams config
        const configPath = findConfigFile();
        const teamsConfig = configPath ? loadTeamsConfig(configPath) : loadTeamsConfig("");

        // Resolve team definition
        const teamDef = resolveTeam(opts.team, teamsConfig.teams);
        if (!teamDef) {
          console.error(
            chalk.red(
              `Unknown team: ${opts.team}\nAvailable presets: solo, pair, quad\nCustom teams: ${Object.keys(teamsConfig.teams).join(", ") || "(none)"}`,
            ),
          );
          process.exit(1);
        }

        // Cost estimation display
        const agentNames = Object.entries(teamDef.agents)
          .map(([name, cfg]) => `${name}/${cfg.model ?? "sonnet"}`)
          .join(", ");

        console.log();
        console.log(`  ${chalk.bold("Team:")}    ${opts.team} (${teamDef.description})`);
        console.log(`  ${chalk.bold("Agents:")}  ${agentNames}`);
        console.log(`  ${chalk.bold("Phases:")}  ${teamDef.phases.join(" → ")}`);
        console.log(`  ${chalk.bold("Project:")} ${projectId}`);
        if (issueId) console.log(`  ${chalk.bold("Issue:")}   ${issueId}`);
        console.log(`  ${chalk.bold("Cost:")}    ~$2–8 (varies by task complexity)`);
        console.log();

        // Pre-flight checks
        const runtimeName = project.runtime ?? config.defaults.runtime;
        if (runtimeName === "tmux") {
          await preflight.checkTmux();
        }

        // Resolve plugins
        const spinner = ora("Initializing team").start();

        try {
          const plugins = await resolveTeamPlugins(config, projectId);

          // Dynamically import the team spawner
          const { spawnTeam } = await import("@composio/ao-phase-engine");

          spinner.text = "Spawning team...";

          const result = await spawnTeam({
            project,
            projectId,
            team: teamDef,
            teamName: opts.team,
            taskDescription: issueId
              ? `Work on issue: ${issueId}`
              : "Complete the assigned task.",
            issueId,
            branch: opts.branch,
            globalSkills: teamsConfig.skills,
            runtime: plugins.runtime,
            agent: plugins.agent,
            workspace: plugins.workspace,
            testTasks: teamsConfig.testTasks as Record<string, TestTaskConfig> | undefined,
            notifyHuman: async (message: string, priority: "urgent" | "info") => {
              const icon = priority === "urgent" ? "🚨" : "ℹ️";
              console.log(`\n${icon} ${message}\n`);
            },
          });

          // Report final state
          const completedPhases = result.state.phases.filter((p) => p.state === "completed").length;
          const totalPhases = result.state.phases.length;
          const failedPhases = result.state.phases.filter((p) => p.state === "failed");

          if (failedPhases.length > 0) {
            spinner.warn(
              `Team completed ${completedPhases}/${totalPhases} phases (${failedPhases.length} failed)`,
            );
            for (const fp of failedPhases) {
              console.log(chalk.red(`  ✗ ${fp.phase}: ${fp.error}`));
            }
          } else {
            spinner.succeed(`Team completed all ${totalPhases} phases`);
          }

          console.log(`  Worktree: ${chalk.dim(result.worktreePath)}`);
          console.log(`  Branch:   ${chalk.dim(result.branch)}`);
          console.log();
        } catch (err) {
          spinner.fail("Team execution failed");
          console.error(chalk.red(`  ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );

  // --- ao team status ---
  team
    .command("status")
    .description("Show running team statuses")
    .argument("[worktree]", "Worktree path to inspect")
    .action(async (worktreePath?: string) => {
      if (worktreePath) {
        // Show status for a specific team
        const { AgentBus } = await import("@composio/ao-agent-bus");
        const agentsDir = `${worktreePath}/.agents`;
        const bus = new AgentBus({ agentsDir });

        const statuses = bus.readAllStatuses();
        if (statuses.length === 0) {
          console.log(chalk.yellow("No team found in this worktree."));
          return;
        }

        // Read team state
        const { readFileSync, existsSync } = await import("node:fs");
        const statePath = `${agentsDir}/team-state.json`;
        if (existsSync(statePath)) {
          try {
            const state = JSON.parse(readFileSync(statePath, "utf-8"));
            console.log(`  Team: ${chalk.bold(state.teamName)}`);
            console.log(`  Phase: ${chalk.cyan(state.currentPhase)}`);
            console.log();

            for (const phaseRecord of state.phases) {
              const icon =
                phaseRecord.state === "completed"
                  ? chalk.green("✓")
                  : phaseRecord.state === "running"
                    ? chalk.yellow("►")
                    : phaseRecord.state === "failed"
                      ? chalk.red("✗")
                      : chalk.dim("○");
              console.log(`  ${icon} ${phaseRecord.phase} ${chalk.dim(`(${phaseRecord.state})`)}`);
            }
          } catch {
            // Fall through to agent status display
          }
        }

        console.log();
        console.log(chalk.bold("  Agent Statuses:"));
        for (const status of statuses) {
          const stateColor =
            status.state === "done"
              ? chalk.green
              : status.state === "working"
                ? chalk.yellow
                : status.state === "failed"
                  ? chalk.red
                  : chalk.dim;
          console.log(
            `  ${status.name} (${status.role}): ${stateColor(status.state)}${status.currentFile ? ` — ${status.currentFile}` : ""}`,
          );
        }
        console.log();
      } else {
        console.log(chalk.yellow("Usage: ao team status <worktree-path>"));
        console.log(chalk.dim("  Inspect team state in a specific worktree"));
      }
    });

  // --- ao team stop ---
  team
    .command("stop")
    .description("Stop a running team")
    .argument("<worktree>", "Worktree path of the team to stop")
    .option("--reason <reason>", "Reason for stopping", "User requested stop")
    .action(async (worktreePath: string, opts: { reason: string }) => {
      const { AgentBus } = await import("@composio/ao-agent-bus");
      const agentsDir = `${worktreePath}/.agents`;
      const bus = new AgentBus({ agentsDir });

      bus.writeControl({
        signal: "shutdown",
        ts: new Date().toISOString(),
        reason: opts.reason,
      });

      console.log(chalk.green(`Stop signal sent to team at ${worktreePath}`));
      console.log(chalk.dim(`  Reason: ${opts.reason}`));
    });
}
