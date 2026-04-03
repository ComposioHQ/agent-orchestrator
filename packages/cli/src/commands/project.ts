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
import { existsSync, statSync } from "node:fs";
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
import { getRunning } from "../lib/running-state.js";
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

        if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
          console.error(chalk.red(`Error: path does not exist or is not a directory: ${projectPath}`));
          process.exit(1);
        }

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

        // Reject if any existing project shares the same directory basename.
        // validateProjectUniqueness checks basename(project.path) uniqueness, so two
        // projects at e.g. /work/app and /personal/app would break subsequent config loads.
        const newBasename = basename(projectPath);
        const basenameConflict = Object.entries(globalConfig.projects).find(
          ([, existing]) =>
            basename(resolve(expandHome(existing.path))) === newBasename &&
            resolve(expandHome(existing.path)) !== projectPath,
        );
        if (basenameConflict) {
          const [conflictId, conflictEntry] = basenameConflict;
          console.error(
            chalk.red(
              `Error: directory basename "${newBasename}" conflicts with project "${conflictId}" (${conflictEntry.path}).\n` +
              `  Rename the directory to use a unique name, then run \`ao project add\` again.`,
            ),
          );
          process.exit(1);
        }

        // Derive ID
        let projectId = opts.id ?? generateSessionPrefix(generateProjectId(projectPath));

        // Handle ID collision
        let idSuffixed = false;
        if (globalConfig.projects[projectId]) {
          const conflicting = globalConfig.projects[projectId];
          if (resolve(expandHome(conflicting.path)) !== projectPath) {
            let suffix = 2;
            while (globalConfig.projects[`${projectId}${suffix}`]) suffix++;
            const altId = `${projectId}${suffix}`;
            console.log(chalk.yellow(`ID "${projectId}" already taken, using "${altId}"`));
            projectId = altId;
            idSuffixed = true;
          }
        }

        const entry: GlobalProjectEntry = {
          name: opts.name ?? basename(projectPath),
          path: projectPath,
          // When the ID was suffixed due to collision (e.g. "ao" → "ao2"), store the
          // derived prefix in the registry entry so buildEffectiveConfig uses it instead
          // of re-deriving "oa" from the path basename, which would cause
          // validateProjectUniqueness to throw "Duplicate session prefix".
          ...(idSuffixed && { sessionPrefix: projectId }),
        } as GlobalProjectEntry;
        globalConfig = registerProjectInConfig(globalConfig, projectId, entry);

        // Save registry first so the project entry exists even if shadow sync fails.
        // An orphan shadow file (shadow exists, no registry entry) is harder to
        // recover from than a registered project with a missing shadow file.
        saveGlobalConfig(globalConfig);

        // Sync shadow if hybrid
        const mode = detectConfigMode(projectPath);
        if (mode === "hybrid") {
          const localPath = findLocalConfigPath(projectPath);
          if (localPath) {
            try {
              const localConfig = loadLocalProjectConfig(localPath);
              const { excludedSecrets } = syncShadow(globalConfig, projectId, localConfig);
              if (excludedSecrets.length > 0) {
                console.log(chalk.yellow(`  Excluded secret-like fields: ${excludedSecrets.join(", ")}`));
              }
            } catch (err) {
              console.log(chalk.yellow(`  Could not sync local config: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
        }

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

        // Remove from global config, then clean up shadow file
        const updated = unregisterProject(globalConfig, projectId);
        saveGlobalConfig(updated);
        deleteShadowFile(projectId);

        console.log(chalk.green(`✓ Removed "${projectId}" from global config`));
        console.log(chalk.dim("  Local config (if any) was NOT deleted."));
        console.log(chalk.dim("  Session data was NOT deleted."));

        // Warn if a daemon is running — the lifecycle manager lives in the
        // `ao start` process and cannot be stopped cross-process. The project
        // has been removed from config so no new sessions will be created, but
        // existing polls will continue until the daemon is restarted.
        try {
          const running = await getRunning();
          if (running) {
            console.log(chalk.yellow(`\n  ⚠ ao start is running (PID ${running.pid}). Restart it to stop lifecycle polling for "${projectId}".`));
            console.log(chalk.dim(`    Run: ao stop && ao start`));
          }
        } catch (runningErr) {
          // Non-critical: running.json may not exist or be unreadable
          console.warn(chalk.dim(`  (Could not check daemon status: ${runningErr instanceof Error ? runningErr.message : String(runningErr)})`));
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

