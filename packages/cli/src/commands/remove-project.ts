/**
 * `ao remove-project <id>` — remove a project from the global config registry.
 *
 * Does NOT delete the local config or project files.
 * Handles active sessions and worktrees interactively.
 */

import chalk from "chalk";
import type { Command } from "commander";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  unregisterProject,
  deleteShadowFile,
  loadConfig,
} from "@composio/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";
import { stopLifecycleWorker } from "../lib/lifecycle-service.js";
import { promptConfirm } from "../lib/prompts.js";
import { isHumanCaller } from "../lib/caller-context.js";

export function registerRemoveProject(program: Command): void {
  program
    .command("remove-project <id>")
    .description("Remove a project from the global config registry")
    .option("--force", "Skip confirmation prompts")
    .action(async (projectId: string, opts: { force?: boolean }) => {
      try {
        const globalConfig = loadGlobalConfig();
        if (!globalConfig) {
          console.error(chalk.red("No global config found. Nothing to remove."));
          process.exit(1);
        }

        const entry = globalConfig.projects[projectId];
        if (!entry) {
          console.error(chalk.red(`Project "${projectId}" not found in global config.`));
          console.error(chalk.dim(`Available: ${Object.keys(globalConfig.projects).join(", ")}`));
          process.exit(1);
        }

        // Check for active sessions
        let activeSessions: string[] = [];
        try {
          const config = loadConfig();
          const sm = await getSessionManager(config);
          const sessions = await sm.list(projectId);
          activeSessions = sessions.map((s) => s.id);
        } catch {
          // Session manager not available — proceed
        }

        // Show what will happen
        console.log(chalk.bold(`\nRemoving project "${entry.name ?? projectId}"\n`));
        console.log(chalk.dim(`  Path: ${entry.path}`));
        if (activeSessions.length > 0) {
          console.log(chalk.yellow(`  Active sessions: ${activeSessions.join(", ")}`));
        }
        console.log();

        // Confirm
        if (!opts.force && isHumanCaller()) {
          const confirmed = await promptConfirm(
            `Remove "${projectId}" from global config?${activeSessions.length > 0 ? " (active sessions will be orphaned)" : ""}`,
            false,
          );
          if (!confirmed) {
            console.log(chalk.dim("Cancelled."));
            return;
          }
        }

        // Stop per-project lifecycle worker if one exists.
        // If a poll-all worker is running instead, we intentionally don't stop it
        // since it covers other projects too.
        try {
          const config = loadConfig();
          await stopLifecycleWorker(config, projectId);
        } catch {
          // Not critical — worker may not be running or may be poll-all
        }

        // Remove from global config, then clean up shadow file
        const updated = unregisterProject(globalConfig, projectId);
        saveGlobalConfig(updated);
        deleteShadowFile(projectId);

        console.log(chalk.green(`✓ Removed "${projectId}" from global config`));
        console.log(chalk.dim("  Local config (if any) was NOT deleted."));
        console.log(chalk.dim("  Session data was NOT deleted."));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
