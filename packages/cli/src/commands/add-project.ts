import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import chalk from "chalk";
import type { Command } from "commander";
import { generateSessionPrefix, findConfigFile } from "@composio/ao-core";
import { git, execSilent } from "../lib/shell.js";
import { detectDefaultBranch } from "../lib/git-utils.js";
import {
  detectProjectType,
  generateRulesFromTemplates,
  formatProjectTypeForDisplay,
} from "../lib/project-detection.js";

export function registerAddProject(program: Command): void {
  program
    .command("add-project")
    .description("Add a project to the existing agent-orchestrator.yaml config")
    .argument("<path>", "Path to the project repository")
    .option("--no-rules", "Skip generating agent rules")
    .option("-c, --config <path>", "Path to agent-orchestrator.yaml (auto-detected if omitted)")
    .action(async (projectPath: string, opts: { rules: boolean; config?: string }) => {
      // Resolve the project path
      const resolvedPath = resolve(projectPath.replace(/^~/, process.env.HOME || ""));

      // Find existing config
      const configPath = opts.config ? resolve(opts.config) : findConfigFile();
      if (!configPath) {
        console.error(chalk.red("No agent-orchestrator.yaml found."));
        console.log(chalk.dim("Run `ao init` first to create a config, then add projects to it."));
        process.exit(1);
      }

      console.log(chalk.bold.cyan("\n  Agent Orchestrator — Add Project\n"));

      // Load and parse existing config
      const rawYaml = readFileSync(configPath, "utf-8");
      const config = yamlParse(rawYaml);

      if (!config.projects) {
        config.projects = {};
      }

      // Derive project ID from directory name
      const projectId = basename(resolvedPath);

      // Check if project already exists
      if (config.projects[projectId]) {
        console.error(chalk.red(`Project "${projectId}" already exists in ${configPath}`));
        process.exit(1);
      }

      // Detect git info
      console.log(chalk.dim("  Detecting project info...\n"));

      const isGitRepo = (await git(["rev-parse", "--git-dir"], resolvedPath)) !== null;
      if (!isGitRepo) {
        console.error(chalk.red(`"${resolvedPath}" is not a git repository.`));
        process.exit(1);
      }

      // Get remote
      let ownerRepo: string | null = null;
      const gitRemote = await git(["remote", "get-url", "origin"], resolvedPath);
      if (gitRemote) {
        const match = gitRemote.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
        if (match) ownerRepo = match[1];
      }

      // Detect default branch
      const defaultBranch = await detectDefaultBranch(resolvedPath, ownerRepo);

      // Generate session prefix and ensure uniqueness
      let prefix = generateSessionPrefix(projectId);
      const existingPrefixes = new Set(
        Object.values(config.projects as Record<string, Record<string, unknown>>).map(
          (p) =>
            (p.sessionPrefix as string) || generateSessionPrefix(basename(p.path as string)),
        ),
      );

      if (existingPrefixes.has(prefix)) {
        // Append a number to make it unique
        let i = 2;
        while (existingPrefixes.has(`${prefix}${i}`)) i++;
        prefix = `${prefix}${i}`;
      }

      // Detect project type and generate rules
      const projectType = detectProjectType(resolvedPath);

      // Show what was detected
      console.log(chalk.green(`  ✓ Git repository`));
      if (ownerRepo) {
        console.log(chalk.dim(`    Remote: ${ownerRepo}`));
      } else {
        console.log(chalk.yellow(`    ⚠ Could not detect GitHub remote`));
      }
      console.log(chalk.dim(`    Default branch: ${defaultBranch}`));
      console.log(chalk.dim(`    Session prefix: ${prefix}`));

      if (projectType.languages.length > 0 || projectType.frameworks.length > 0) {
        console.log(chalk.green("  ✓ Project type detected"));
        const formattedType = formatProjectTypeForDisplay(projectType);
        formattedType.split("\n").forEach((line) => {
          console.log(chalk.dim(`    ${line}`));
        });
      }

      console.log();

      // Build project config
      const projectConfig: Record<string, unknown> = {
        repo: ownerRepo || "owner/repo",
        path: resolvedPath,
        defaultBranch,
        sessionPrefix: prefix,
      };

      if (opts.rules) {
        const agentRules = generateRulesFromTemplates(projectType);
        if (agentRules) {
          projectConfig.agentRules = agentRules;
        }
      }

      // Add to config and write
      config.projects[projectId] = projectConfig;
      const updatedYaml = yamlStringify(config, { indent: 2 });
      writeFileSync(configPath, updatedYaml);

      console.log(chalk.green(`✓ Added "${projectId}" to ${configPath}\n`));

      if (!ownerRepo) {
        console.log(chalk.yellow("⚠ Could not detect GitHub remote."));
        console.log(chalk.dim(`  Update the 'repo' field in the config before spawning agents.\n`));
      }

      console.log(chalk.bold("Next steps:\n"));
      console.log(chalk.dim(`  Run these from the directory where ${configPath} lives:\n`));
      console.log(`  1. Start (or restart) the orchestrator:`);
      console.log(chalk.cyan(`     ao start\n`));
      console.log(`  2. Spawn an agent for this project:`);
      console.log(chalk.cyan(`     ao spawn ${projectId} <issue-number>\n`));
      console.log(`  Want to add another project?`);
      console.log(chalk.cyan(`     ao add-project ~/path/to/repo\n`));
    });
}
