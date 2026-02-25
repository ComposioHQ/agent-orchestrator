/**
 * `ao check-issues` — fetch open issues and spawn agents for uncovered ones.
 *
 * Also exports `checkAndSpawnIssues()` so `ao start` can call it after startup.
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  type OrchestratorConfig,
  type ProjectConfig,
  type Tracker,
  type SessionManager,
} from "@composio/ao-core";
import { getSessionManager, getRegistry } from "../lib/create-session-manager.js";

/** Statuses that indicate a session is no longer active. */
const DEAD_STATUSES = new Set(["killed", "done", "terminated"]);
/** Activity states that indicate the agent process is gone. */
const DEAD_ACTIVITIES = new Set(["exited"]);

export interface CheckIssuesResult {
  spawned: string[];
  alreadyCovered: string[];
  failed: Array<{ issueId: string; error: string }>;
  skippedNoTracker: boolean;
}

/**
 * Check open issues and spawn agents for any without active sessions.
 * Reusable by both the standalone command and `ao start`.
 */
export async function checkAndSpawnIssues(
  config: OrchestratorConfig,
  projectId: string,
  project: ProjectConfig,
  options: { dryRun?: boolean } = {},
): Promise<CheckIssuesResult> {
  const result: CheckIssuesResult = {
    spawned: [],
    alreadyCovered: [],
    failed: [],
    skippedNoTracker: false,
  };

  // Get tracker plugin
  if (!project.tracker) {
    result.skippedNoTracker = true;
    return result;
  }

  const registry = await getRegistry(config);
  const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
  if (!tracker) {
    result.skippedNoTracker = true;
    return result;
  }

  if (!tracker.listIssues) {
    console.log(chalk.yellow("Tracker plugin does not support listIssues"));
    result.skippedNoTracker = true;
    return result;
  }

  // Fetch open issues
  const openIssues = await tracker.listIssues({ state: "open" }, project);

  if (openIssues.length === 0) {
    return result;
  }

  // Get existing sessions
  const sm = await getSessionManager(config);
  const existingSessions = await sm.list(projectId);

  // Build map of actively-worked issue IDs
  const activeIssueMap = new Map(
    existingSessions
      .filter((s) => {
        if (!s.issueId) return false;
        if (DEAD_STATUSES.has(s.status)) return false;
        if (s.activity && DEAD_ACTIVITIES.has(s.activity)) return false;
        return true;
      })
      .map((s) => [s.issueId!.toLowerCase(), s.id]),
  );

  // Determine which issues need sessions
  const uncovered = openIssues.filter(
    (issue) => !activeIssueMap.has(issue.id.toLowerCase()),
  );

  for (const issue of openIssues) {
    if (activeIssueMap.has(issue.id.toLowerCase())) {
      result.alreadyCovered.push(issue.id);
    }
  }

  if (options.dryRun) {
    // In dry-run mode, report what would happen without spawning
    result.spawned = uncovered.map((i) => i.id);
    return result;
  }

  // Spawn sessions for uncovered issues
  for (const issue of uncovered) {
    try {
      await sm.spawn({ projectId, issueId: issue.id });
      result.spawned.push(issue.id);
    } catch (err) {
      result.failed.push({
        issueId: issue.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Small delay between spawns to avoid overwhelming the system
    if (uncovered.indexOf(issue) < uncovered.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return result;
}

/** Print a human-readable summary of the check-issues result. */
function printSummary(result: CheckIssuesResult, dryRun: boolean): void {
  if (result.skippedNoTracker) {
    console.log(chalk.dim("  No tracker configured — skipping issue check"));
    return;
  }

  const total = result.spawned.length + result.alreadyCovered.length + result.failed.length;
  if (total === 0) {
    console.log(chalk.dim("  No open issues found"));
    return;
  }

  const prefix = dryRun ? "[dry-run] " : "";

  if (result.spawned.length > 0) {
    const verb = dryRun ? "Would spawn" : "Spawned";
    console.log(chalk.green(`  ${prefix}${verb}: ${result.spawned.length} sessions`));
    for (const id of result.spawned) {
      console.log(chalk.dim(`    - ${id}`));
    }
  }

  if (result.alreadyCovered.length > 0) {
    console.log(chalk.dim(`  Already covered: ${result.alreadyCovered.length} issues`));
  }

  if (result.failed.length > 0) {
    console.log(chalk.red(`  Failed: ${result.failed.length}`));
    for (const f of result.failed) {
      console.log(chalk.dim(`    - ${f.issueId}: ${f.error}`));
    }
  }
}

export function registerCheckIssues(program: Command): void {
  program
    .command("check-issues [project]")
    .description("Check open issues and spawn agents for uncovered ones")
    .option("--dry-run", "Show what would be spawned without actually spawning")
    .action(async (projectArg?: string, opts?: { dryRun?: boolean }) => {
      try {
        const config = loadConfig();
        const projectIds = Object.keys(config.projects);

        if (projectIds.length === 0) {
          console.error(chalk.red("No projects configured."));
          process.exit(1);
        }

        // Resolve project (same logic as start command)
        let projectId: string;
        if (projectArg) {
          if (!config.projects[projectArg]) {
            console.error(
              chalk.red(
                `Unknown project: ${projectArg}\nAvailable: ${projectIds.join(", ")}`,
              ),
            );
            process.exit(1);
          }
          projectId = projectArg;
        } else if (projectIds.length === 1) {
          projectId = projectIds[0];
        } else {
          console.error(
            chalk.red(
              `Multiple projects configured. Specify which one:\n  ${projectIds.map((id) => `ao check-issues ${id}`).join("\n  ")}`,
            ),
          );
          process.exit(1);
        }

        const project = config.projects[projectId];
        const dryRun = opts?.dryRun ?? false;

        console.log(
          chalk.bold(
            `\n${dryRun ? "[dry-run] " : ""}Checking issues for ${chalk.cyan(project.name)}\n`,
          ),
        );

        const spinner = ora("Fetching open issues").start();
        const result = await checkAndSpawnIssues(config, projectId, project, { dryRun });
        spinner.stop();

        printSummary(result, dryRun);
        console.log();
      } catch (err) {
        console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}
