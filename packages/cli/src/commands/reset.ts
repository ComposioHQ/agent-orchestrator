/**
 * `ao reset` — fully wipe a project's local AO state and reinitialize.
 *
 * Removes all AO-managed local data for a project:
 * - Sessions (active + archived)
 * - Worktrees
 * - Feedback reports
 * - Orchestrator runtime state
 * - .origin file and project base directory
 *
 * Optionally kills all live tmux sessions before removal.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { cwd } from "node:process";
import chalk from "chalk";
import type { Command } from "commander";
import {
  loadConfig,
  getProjectBaseDir,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@aoagents/ao-core";
import { promptConfirm } from "../lib/prompts.js";
import { findProjectForDirectory } from "../lib/project-resolution.js";
import { isHumanCaller } from "../lib/caller-context.js";
import { getSessionManager } from "../lib/create-session-manager.js";

/**
 * Resolve project from config — auto-detect from cwd or use explicit argument.
 */
function resolveProjectForReset(
  config: OrchestratorConfig,
  projectArg?: string,
): { projectId: string; project: ProjectConfig } {
  const projectIds = Object.keys(config.projects);

  if (projectIds.length === 0) {
    throw new Error("No projects configured. Nothing to reset.");
  }

  if (projectArg) {
    const project = config.projects[projectArg];
    if (!project) {
      throw new Error(
        `Project "${projectArg}" not found. Available projects:\n  ${projectIds.join(", ")}`,
      );
    }
    return { projectId: projectArg, project };
  }

  // Single project — use it
  if (projectIds.length === 1) {
    const projectId = projectIds[0];
    return { projectId, project: config.projects[projectId] };
  }

  // Multiple projects — try matching cwd
  const currentDir = resolve(cwd());
  const matchedProjectId = findProjectForDirectory(config.projects, currentDir);
  if (matchedProjectId) {
    return { projectId: matchedProjectId, project: config.projects[matchedProjectId] };
  }

  throw new Error(
    `Multiple projects configured. Specify which one to reset:\n  ${projectIds.map((id) => `ao reset ${id}`).join("\n  ")}\n\nOr use ao reset --all to reset all projects.`,
  );
}

/**
 * Collect what will be deleted for a project.
 */
function collectDeletionTargets(
  config: OrchestratorConfig,
  project: ProjectConfig,
): { baseDir: string; items: Array<{ path: string; label: string; size?: number }> } {
  const configPath = config.configPath;
  if (!configPath) {
    throw new Error("Cannot determine config path. Ensure config is loaded.");
  }

  const baseDir = getProjectBaseDir(configPath, project.path);

  const items: Array<{ path: string; label: string; size?: number }> = [];

  if (!existsSync(baseDir)) {
    return { baseDir, items };
  }

  try {
    const entries = readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(baseDir, entry.name);
      let size: number | undefined;
      try {
        if (entry.isDirectory()) {
          size = getDirSize(fullPath);
        } else {
          size = statSync(fullPath).size;
        }
      } catch {
        // Ignore stat errors
      }
      items.push({
        path: fullPath,
        label: entry.name,
        size,
      });
    }
  } catch {
    // Directory might not be readable
  }

  return { baseDir, items };
}

/**
 * Get approximate directory size recursively (best-effort).
 */
function getDirSize(dirPath: string): number {
  let totalSize = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          totalSize += getDirSize(fullPath);
        } else {
          totalSize += statSync(fullPath).size;
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Skip inaccessible directories
  }
  return totalSize;
}

/**
 * Format byte size for display.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Kill all live sessions for a project before wiping state.
 */
async function killProjectSessions(
  config: OrchestratorConfig,
  projectId: string,
): Promise<number> {
  let killed = 0;
  try {
    const sm = await getSessionManager(config);
    const sessions = await sm.list(projectId);
    for (const session of sessions) {
      try {
        await sm.kill(session.id);
        killed++;
      } catch {
        // Session might already be dead
      }
    }
  } catch {
    // Session manager might fail if state is corrupted — that's fine, we're wiping it
  }
  return killed;
}

export function registerReset(program: Command): void {
  program
    .command("reset [project]")
    .description("Fully wipe a project's local AO state and reinitialize from scratch")
    .option("-p, --project <id>", "Specify project ID to reset")
    .option("--yes", "Skip confirmation prompt")
    .option("--all", "Reset all projects")
    .action(
      async (
        projectArg?: string,
        opts: { project?: string; yes?: boolean; all?: boolean } = {},
      ) => {
        const config = loadConfig();
        const effectiveProjectArg = projectArg ?? opts.project;

        // Determine which projects to reset
        let targets: Array<{ projectId: string; project: ProjectConfig }>;

        if (opts.all) {
          targets = Object.entries(config.projects).map(([id, project]) => ({
            projectId: id,
            project,
          }));
          if (targets.length === 0) {
            console.log(chalk.yellow("No projects configured. Nothing to reset."));
            return;
          }
        } else {
          const resolved = resolveProjectForReset(config, effectiveProjectArg);
          targets = [resolved];
        }

        // Collect all deletion targets
        const allTargets = targets.map(({ projectId, project }) => ({
          projectId,
          project,
          ...collectDeletionTargets(config, project),
        }));

        const hasAnyItems = allTargets.some((t) => t.items.length > 0);
        if (!hasAnyItems) {
          console.log(chalk.yellow("\nNo AO state found for the specified project(s). Nothing to reset.\n"));
          return;
        }

        // Display what will be deleted
        console.log(chalk.bold("\nThe following AO state will be deleted:\n"));

        for (const { projectId, baseDir, items } of allTargets) {
          if (items.length === 0) {
            console.log(chalk.dim(`  ${projectId}: (no state found)`));
            continue;
          }

          console.log(chalk.cyan(`  ${projectId}:`));
          console.log(chalk.dim(`    ${baseDir}/`));
          for (const item of items) {
            const sizeStr = item.size !== undefined ? chalk.dim(` (${formatSize(item.size)})`) : "";
            console.log(`      ${item.label}${sizeStr}`);
          }
          console.log();
        }

        // Confirm
        if (!opts.yes) {
          if (!isHumanCaller()) {
            console.error(
              chalk.red("Cannot confirm interactively in non-TTY mode. Use --yes to skip confirmation."),
            );
            process.exit(1);
          }
          const confirmed = await promptConfirm(
            "This will permanently delete all AO state for the above project(s). Continue?",
            false,
          );
          if (!confirmed) {
            console.log(chalk.yellow("\nReset cancelled.\n"));
            return;
          }
        }

        // Execute reset
        for (const { projectId, baseDir, items } of allTargets) {
          if (items.length === 0) continue;

          console.log(chalk.bold(`\nResetting ${chalk.cyan(projectId)}...`));

          // Kill live sessions first
          const killed = await killProjectSessions(config, projectId);
          if (killed > 0) {
            console.log(chalk.dim(`  Killed ${killed} live session${killed !== 1 ? "s" : ""}`));
          }

          // Remove the entire project base directory
          try {
            rmSync(baseDir, { recursive: true, force: true });
            console.log(chalk.green(`  ✓ Removed ${baseDir}`));
          } catch (err) {
            console.error(
              chalk.red(`  ✗ Failed to remove ${baseDir}: ${err instanceof Error ? err.message : String(err)}`),
            );
          }
        }

        console.log(chalk.green("\n✓ Reset complete. Project state has been wiped.\n"));
      },
    );
}
