import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import {
  getPortfolio,
  getPortfolioSessionCounts,
  registerProject,
  unregisterProject,
  loadPreferences,
  savePreferences,
  loadLocalProjectConfig,
} from "@composio/ao-core";
import {
  formatPortfolioDegradedReason,
  formatPortfolioProjectName,
  formatPortfolioProjectStatus,
} from "../lib/portfolio-display.js";

export function registerProject_cmd(program: Command): void {
  const project = program
    .command("project")
    .description("Manage portfolio projects");

  // ao project ls
  project
    .command("ls")
    .description("List all portfolio projects")
    .action(async () => {
      const portfolio = getPortfolio();

      if (portfolio.length === 0) {
        console.log(chalk.dim("No projects in portfolio."));
        console.log(chalk.dim("Run `ao start` in a project or `ao project add <path>` to register one."));
        return;
      }

      const counts = await getPortfolioSessionCounts(portfolio);
      const prefs = loadPreferences();

      console.log(chalk.bold("\nPortfolio Projects\n"));

      for (const p of portfolio) {
        const count = counts[p.id] || { total: 0, active: 0 };
        const isDefault = prefs.defaultProjectId === p.id;
        const status = formatPortfolioProjectStatus(p, count);

        const pin = p.pinned ? chalk.yellow("*") : " ";
        const def = isDefault ? chalk.cyan(" (default)") : "";
        const name = formatPortfolioProjectName(p);
        const degradedReason = formatPortfolioDegradedReason(p);

        console.log(`  ${pin} ${chalk.bold(p.id)}${name}${def}`);
        console.log(`    ${status} | ${count.total} sessions | ${chalk.dim(p.source)}`);
        if (degradedReason) {
          console.log(`    ${degradedReason}`);
        }
      }

      console.log();
    });

  // ao project add <path>
  project
    .command("add <path>")
    .description("Register a project path in the portfolio")
    .option("-k, --key <key>", "Config project key (for multi-project configs)")
    .action((path: string, opts: { key?: string }) => {
      const resolvedPath = resolve(path.replace(/^~/, process.env["HOME"] || ""));

      if (!loadLocalProjectConfig(resolvedPath)) {
        console.error(chalk.red(`No agent-orchestrator.yaml found at ${resolvedPath}`));
        process.exit(1);
      }

      registerProject(resolvedPath, opts.key);
      console.log(chalk.green(`Registered project at ${resolvedPath}`));
    });

  // ao project rm <id>
  project
    .command("rm <id>")
    .description("Remove a project from the portfolio")
    .action((id: string) => {
      const portfolio = getPortfolio();
      const found = portfolio.find((p) => p.id === id);
      if (!found) {
        console.error(chalk.red(`Project "${id}" not found in portfolio`));
        process.exit(1);
      }

      unregisterProject(id);
      console.log(chalk.green(`Removed project "${id}" from portfolio`));
    });

  // ao project set-default <id>
  project
    .command("set-default <id>")
    .description("Set the default project for the portfolio")
    .action((id: string) => {
      const portfolio = getPortfolio();
      const found = portfolio.find((p) => p.id === id);
      if (!found) {
        console.error(chalk.red(`Project "${id}" not found in portfolio`));
        process.exit(1);
      }

      const prefs = loadPreferences();
      prefs.defaultProjectId = id;
      savePreferences(prefs);
      console.log(chalk.green(`Set default project to "${id}"`));
    });
}
