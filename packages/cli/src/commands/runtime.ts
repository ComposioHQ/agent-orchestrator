import { readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "@composio/ao-core";
import { parseDocument } from "yaml";
import { formatRuntimeSelection, getRuntimeSelection } from "../lib/runtime-selection.js";

function requireProject(projectId: string) {
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
  return { config, project };
}

function parseConfigDocument(configPath: string) {
  const doc = parseDocument(readFileSync(configPath, "utf-8"));
  if (doc.errors.length > 0) {
    throw new Error(doc.errors.map((error) => error.message).join("; "));
  }
  return doc;
}

function writeConfigDocument(
  configPath: string,
  doc: ReturnType<typeof parseConfigDocument>,
): void {
  writeFileSync(configPath, String(doc), "utf-8");
}

export function registerRuntime(program: Command): void {
  const runtime = program
    .command("runtime")
    .description("Inspect or persist runtime selection for projects");

  runtime
    .command("show")
    .description("Show the effective runtime for one project or all projects")
    .argument("[project]", "Project ID from config")
    .action((projectId?: string) => {
      const config = loadConfig();
      const projectIds = projectId ? [projectId] : Object.keys(config.projects);

      if (projectId && !config.projects[projectId]) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      for (const id of projectIds) {
        const selection = getRuntimeSelection(config, id);
        console.log(`${chalk.bold(id)}: ${chalk.dim(formatRuntimeSelection(selection))}`);
      }
      console.log(chalk.dim(`Config: ${config.configPath}`));
    });

  runtime
    .command("set")
    .description("Persist a runtime override for a project in agent-orchestrator.yaml")
    .argument("<project>", "Project ID from config")
    .argument("<runtime>", "Runtime plugin name to persist (e.g. tmux, docker)")
    .action((projectId: string, runtimeName: string) => {
      const normalizedRuntime = runtimeName.trim();
      if (!normalizedRuntime) {
        console.error(chalk.red("Runtime name cannot be empty."));
        process.exit(1);
      }

      const { config, project } = requireProject(projectId);
      const doc = parseConfigDocument(config.configPath);
      doc.setIn(["projects", projectId, "runtime"], normalizedRuntime);
      writeConfigDocument(config.configPath, doc);

      console.log(chalk.green(`Runtime for ${projectId} set to ${normalizedRuntime}.`));
      console.log(chalk.dim(`Config: ${config.configPath}`));
      if (normalizedRuntime === "docker" && !project.runtimeConfig?.["image"]) {
        console.log(
          chalk.yellow(
            "Docker runtime is now enabled for this project. Add projects." +
              `${projectId}.runtimeConfig.image to run sessions successfully.`,
          ),
        );
      }
    });

  runtime
    .command("clear")
    .description("Remove a project runtime override so it falls back to defaults.runtime")
    .argument("<project>", "Project ID from config")
    .action((projectId: string) => {
      const { config } = requireProject(projectId);
      const doc = parseConfigDocument(config.configPath);
      doc.deleteIn(["projects", projectId, "runtime"]);
      writeConfigDocument(config.configPath, doc);

      console.log(
        chalk.green(
          `Runtime override cleared for ${projectId}. Now using ${config.defaults.runtime} (defaults.runtime).`,
        ),
      );
      console.log(chalk.dim(`Config: ${config.configPath}`));
    });
}
