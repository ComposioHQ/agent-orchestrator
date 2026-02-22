/**
 * `ao retro` — view and generate session retrospectives.
 *
 * Subcommands:
 *   ao retro list      — list all retrospectives
 *   ao retro show <id> — show retrospective for a session
 *   ao retro generate <id> — manually generate a retrospective
 */

import chalk from "chalk";
import type { Command } from "commander";
import {
  loadConfig,
  resolveProjectRetroDir,
  loadRetrospectives,
  generateRetrospective,
  saveRetrospective,
  type Retrospective,
} from "@composio/ao-core";

function resolveRetroDir(): string {
  const config = loadConfig();
  const dir = resolveProjectRetroDir(config);
  if (!dir) throw new Error("No projects configured.");
  return dir;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function outcomeColor(outcome: Retrospective["outcome"]): string {
  switch (outcome) {
    case "success": return chalk.green(outcome);
    case "failure": return chalk.red(outcome);
    case "partial": return chalk.yellow(outcome);
  }
}

export function registerRetrospective(program: Command): void {
  const retroCmd = program
    .command("retro")
    .description("View and generate session retrospectives");

  retroCmd
    .command("list")
    .description("List all retrospectives")
    .option("-p, --project <id>", "Filter by project ID")
    .option("-n, --limit <n>", "Limit results", "20")
    .option("--json", "Output as JSON")
    .action((opts: { project?: string; limit?: string; json?: boolean }) => {
      try {
        const retroDir = resolveRetroDir();
        const retros = loadRetrospectives(retroDir, {
          projectId: opts.project,
          limit: parseInt(opts.limit ?? "20", 10),
        });

        if (opts.json) {
          console.log(JSON.stringify(retros, null, 2));
          return;
        }

        if (retros.length === 0) {
          console.log(chalk.dim("No retrospectives found."));
          return;
        }

        // Table header
        console.log(
          chalk.dim(
            "  " +
            "Session".padEnd(18) +
            "Outcome".padEnd(10) +
            "Duration".padEnd(10) +
            "CI".padEnd(5) +
            "Rev".padEnd(5) +
            "Date",
          ),
        );
        console.log(chalk.dim("  " + "─".repeat(65)));

        for (const retro of retros) {
          const date = new Date(retro.generatedAt).toLocaleDateString();
          console.log(
            "  " +
            chalk.cyan(retro.sessionId.padEnd(18)) +
            outcomeColor(retro.outcome).padEnd(10 + 10) + // extra for ANSI
            formatDuration(retro.metrics.totalDurationMs).padEnd(10) +
            String(retro.metrics.ciFailures).padEnd(5) +
            String(retro.metrics.reviewRounds).padEnd(5) +
            chalk.dim(date),
          );
        }
        console.log(chalk.dim(`\n  ${retros.length} retrospectives`));
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  retroCmd
    .command("show <session-id>")
    .description("Show detailed retrospective for a session")
    .option("--json", "Output as JSON")
    .action((sessionId: string, opts: { json?: boolean }) => {
      try {
        const retroDir = resolveRetroDir();
        const retros = loadRetrospectives(retroDir, { sessionId, limit: 1 });

        if (retros.length === 0) {
          console.log(chalk.yellow(`No retrospective found for session "${sessionId}"`));
          return;
        }

        const retro = retros[0];

        if (opts.json) {
          console.log(JSON.stringify(retro, null, 2));
          return;
        }

        console.log(chalk.bold(`\nRetrospective: ${chalk.cyan(retro.sessionId)}\n`));
        console.log(`  Outcome:  ${outcomeColor(retro.outcome)}`);
        console.log(`  Duration: ${formatDuration(retro.metrics.totalDurationMs)}`);
        console.log(`  CI failures: ${retro.metrics.ciFailures}`);
        console.log(`  Review rounds: ${retro.metrics.reviewRounds}`);
        if (retro.reportCard.prUrl) {
          console.log(`  PR: ${chalk.blue(retro.reportCard.prUrl)}`);
        }

        if (retro.timeline.length > 0) {
          console.log(chalk.bold("\n  Timeline:"));
          for (const event of retro.timeline.slice(0, 20)) {
            const time = new Date(event.at).toLocaleTimeString();
            console.log(`    ${chalk.dim(time)} ${event.detail}`);
          }
          if (retro.timeline.length > 20) {
            console.log(chalk.dim(`    ... ${retro.timeline.length - 20} more events`));
          }
        }

        if (retro.lessons.length > 0) {
          console.log(chalk.bold("\n  Lessons:"));
          for (const lesson of retro.lessons) {
            console.log(`    ${chalk.yellow("*")} ${lesson}`);
          }
        }
        console.log();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  retroCmd
    .command("generate <session-id>")
    .description("Manually generate a retrospective for a session")
    .action((sessionId: string) => {
      try {
        const config = loadConfig();
        const projectId = Object.keys(config.projects)[0];
        if (!projectId) throw new Error("No projects configured.");

        const retro = generateRetrospective(sessionId, config, projectId);
        if (!retro) {
          console.log(chalk.yellow(`Could not generate retrospective for "${sessionId}"`));
          return;
        }

        const retroDir = resolveRetroDir();
        saveRetrospective(retro, retroDir);

        console.log(chalk.green(`Retrospective generated for ${sessionId}`));
        console.log(`  Outcome: ${outcomeColor(retro.outcome)}`);
        console.log(`  Duration: ${formatDuration(retro.metrics.totalDurationMs)}`);
        console.log(`  Saved to: ${chalk.dim(retroDir)}`);
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
