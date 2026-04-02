/**
 * `ao project` — manage projects in the global config registry.
 *
 * Subcommands:
 *   ao project list           List all registered projects
 *   ao project add <path>     Register a directory as a project
 *   ao project remove <id>    Unregister a project (does NOT delete files)
 */

import chalk from "chalk";
import { resolve, basename } from "node:path";
import type { Command } from "commander";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  scaffoldGlobalConfig,
  registerProject as registerProjectInConfig,
  unregisterProject,
  deleteShadowFile,
  detectConfigMode,
  findLocalConfigPath,
  loadLocalProjectConfig,
  syncShadow,
  findProjectByPath,
  loadConfig,
  generateSessionPrefix,
  generateProjectId,
  expandHome,
  type GlobalProjectEntry,
} from "@composio/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";
import { stopLifecycleWorker } from "../lib/lifecycle-service.js";
import { promptConfirm } from "../lib/prompts.js";
import { isHumanCaller } from "../lib/caller-context.js";

export function registerProjectCommand(program: Command): void {
  const projectCmd = program
    .command("project")
    .description("Manage projects in the global config registry");

  // -------------------------------------------------------------------------
  // ao project list
  // -------------------------------------------------------------------------
  projectCmd
    .command("list")
    .description("List all registered projects")
    .action(() => {
      const globalConfig = loadGlobalConfig();
      if (!globalConfig) {
        console.log(chalk.dim("No global config found. Run `ao project add <path>` to register a project."));
        return;
      }

      const ids = Object.keys(globalConfig.projects);
      if (ids.length === 0) {
        console.log(chalk.dim("No projects registered."));
        return;
      }

      console.log(chalk.bold(`\nRegistered projects (${ids.length})\n`));
      for (const id of ids) {
        const entry = globalConfig.projects[id];
        console.log(`  ${chalk.green(id.padEnd(16))} ${entry.name ?? id}`);
        console.log(chalk.dim(`  ${"".padEnd(16)} ${entry.path}`));
      }
      console.log();
    });

  // -------------------------------------------------------------------------
  // ao project add <path>
  // -------------------------------------------------------------------------
  projectCmd
    .command("add <path>")
    .description("Register a directory as a project in the global config")
    .option("--id <id>", "Override the derived project ID")
    .option("--name <name>", "Human-readable project name")
    .action(async (rawPath: string, opts: { id?: string; name?: string }) => {
      try {
        const projectPath = resolve(expandHome(rawPath));

        // Load or scaffold global config
        let globalConfig = loadGlobalConfig() ?? scaffoldGlobalConfig();

        // Check if already registered (exact path match)
        const existing = findProjectByPath(globalConfig, projectPath);
        if (existing) {
          const { id: existingId, entry } = existing;
          console.log(chalk.yellow(`Project already registered as "${existingId}" (${entry.name ?? existingId})`));
          console.log(chalk.dim(`  Path: ${entry.path}`));
          return;
        }

        // Derive ID
        let projectId = opts.id ?? generateSessionPrefix(generateProjectId(projectPath));

        // Handle ID collision
        if (globalConfig.projects[projectId]) {
          const conflicting = globalConfig.projects[projectId];
          if (resolve(expandHome(conflicting.path)) !== projectPath) {
            let suffix = 2;
            while (globalConfig.projects[`${projectId}${suffix}`]) suffix++;
            const altId = `${projectId}${suffix}`;
            console.log(chalk.yellow(`ID "${projectId}" already taken, using "${altId}"`));
            projectId = altId;
          }
        }

        const entry: GlobalProjectEntry = {
          name: opts.name ?? basename(projectPath),
          path: projectPath,
        };
        globalConfig = registerProjectInConfig(globalConfig, projectId, entry);

        // Sync shadow if hybrid
        const mode = detectConfigMode(projectPath);
        if (mode === "hybrid") {
          const localPath = findLocalConfigPath(projectPath);
          if (localPath) {
            try {
              const localConfig = loadLocalProjectConfig(localPath);
              const { config: synced, excludedSecrets } = syncShadow(globalConfig, projectId, localConfig);
              globalConfig = synced;
              if (excludedSecrets.length > 0) {
                console.log(chalk.yellow(`  Excluded secret-like fields: ${excludedSecrets.join(", ")}`));
              }
            } catch (err) {
              console.log(chalk.yellow(`  Could not sync local config: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
        }

        saveGlobalConfig(globalConfig);

        console.log(chalk.green(`✓ Registered "${projectId}" (${mode})`));
        console.log(chalk.dim(`  Path: ${projectPath}`));
        console.log(chalk.dim(`  Name: ${entry.name}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // ao project remove <id>
  // -------------------------------------------------------------------------
  projectCmd
    .command("remove <id>")
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

        // Stop per-project lifecycle worker if one exists
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

