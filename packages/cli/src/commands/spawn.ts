import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, type OrchestratorConfig } from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";

async function spawnSession(
  config: OrchestratorConfig,
  projectId: string,
  issueId?: string,
  openTab?: boolean,
  agent?: string,
): Promise<string> {
  const spinner = ora("Creating session").start();

  try {
    const sm = await getSessionManager(config);
    spinner.text = "Spawning session via core";

    const session = await sm.spawn({
      projectId,
      issueId,
      agent,
    });

    spinner.succeed(`Session ${chalk.green(session.id)} created`);

    console.log(`  Worktree: ${chalk.dim(session.workspacePath ?? "-")}`);
    if (session.branch) console.log(`  Branch:   ${chalk.dim(session.branch)}`);

    // Show the tmux name for attaching (stored in metadata or runtimeHandle)
    const tmuxTarget = session.runtimeHandle?.id ?? session.id;
    console.log(`  Attach:   ${chalk.dim(`tmux attach -t ${tmuxTarget}`)}`);
    console.log();

    // Open terminal tab if requested
    if (openTab) {
      try {
        await exec("open-iterm-tab", [tmuxTarget]);
      } catch {
        // Terminal plugin not available
      }
    }

    // Output for scripting
    console.log(`SESSION=${session.id}`);
    return session.id;
  } catch (err) {
    spinner.fail("Failed to create session");
    throw err;
  }
}

export function registerSpawn(program: Command): void {
  program
    .command("spawn")
    .description("Spawn a single agent session")
    .argument("<project>", "Project ID from config")
    .argument("[issue]", "Issue identifier (e.g. INT-1234, #42) - must exist in tracker")
    .option("--open", "Open session in terminal tab")
    .option("--agent <name>", "Override the agent plugin (e.g. codex, claude-code)")
    .action(async (projectId: string, issueId: string | undefined, opts: { open?: boolean; agent?: string }) => {
      const config = loadConfig();
      if (!config.projects[projectId]) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      try {
        await spawnSession(config, projectId, issueId, opts.open, opts.agent);
      } catch (err) {
        console.error(chalk.red(`✗ ${err}`));
        process.exit(1);
      }
    });
}

export function registerBatchSpawn(program: Command): void {
  program
    .command("batch-spawn")
    .description("Spawn sessions for multiple issues with duplicate detection")
    .argument("<project>", "Project ID from config")
    .argument("<issues...>", "Issue identifiers")
    .option("--open", "Open sessions in terminal tabs")
    .action(async (projectId: string, issues: string[], opts: { open?: boolean }) => {
      const config = loadConfig();
      if (!config.projects[projectId]) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      console.log(banner("BATCH SESSION SPAWNER"));
      console.log();
      console.log(`  Project: ${chalk.bold(projectId)}`);
      console.log(`  Issues:  ${issues.join(", ")}`);
      console.log();

      const sm = await getSessionManager(config);
      const created: Array<{ session: string; issue: string }> = [];
      const skipped: Array<{ issue: string; existing: string }> = [];
      const failed: Array<{ issue: string; error: string }> = [];
      const spawnedIssues = new Set<string>();

      // Load existing sessions once before the loop to avoid repeated reads + enrichment.
      // Exclude dead/killed sessions so crashed sessions don't block respawning.
      const deadStatuses = new Set(["killed", "done", "exited"]);
      const existingSessions = await sm.list(projectId);
      const existingIssueMap = new Map(
        existingSessions
          .filter((s) => s.issueId && !deadStatuses.has(s.status))
          .map((s) => [s.issueId!.toLowerCase(), s.id]),
      );

      for (const issue of issues) {
        // Duplicate detection — check both existing sessions and same-run duplicates
        if (spawnedIssues.has(issue.toLowerCase())) {
          console.log(chalk.yellow(`  Skip ${issue} — duplicate in this batch`));
          skipped.push({ issue, existing: "(this batch)" });
          continue;
        }

        // Check existing sessions (pre-loaded before loop)
        const existingSessionId = existingIssueMap.get(issue.toLowerCase());
        if (existingSessionId) {
          console.log(chalk.yellow(`  Skip ${issue} — already has session: ${existingSessionId}`));
          skipped.push({ issue, existing: existingSessionId });
          continue;
        }

        try {
          const sessionName = await spawnSession(config, projectId, issue, opts.open);
          created.push({ session: sessionName, issue });
          spawnedIssues.add(issue.toLowerCase());
        } catch (err) {
          const message = String(err);
          console.error(chalk.red(`  ✗ ${issue} — ${err}`));
          failed.push({ issue, error: message });
        }

        // Small delay between spawns
        await new Promise((r) => setTimeout(r, 500));
      }

      console.log(chalk.bold("\nSummary:"));
      console.log(`  Created: ${chalk.green(String(created.length))} sessions`);
      console.log(`  Skipped: ${chalk.yellow(String(skipped.length))} (duplicate)`);
      console.log(`  Failed:  ${chalk.red(String(failed.length))}`);

      if (created.length > 0) {
        console.log(chalk.bold("\nCreated sessions:"));
        for (const { session, issue } of created) {
          console.log(`  ${chalk.green(session)} -> ${issue}`);
        }
      }
      if (skipped.length > 0) {
        console.log(chalk.bold("\nSkipped (duplicate):"));
        for (const { issue, existing } of skipped) {
          console.log(`  ${issue} -> existing: ${existing}`);
        }
      }
      if (failed.length > 0) {
        console.log(chalk.yellow(`\n${failed.length} failed:`));
        failed.forEach((f) => {
          console.log(chalk.dim(`  - ${f.issue}: ${f.error}`));
        });
      }
      console.log();
    });
}
