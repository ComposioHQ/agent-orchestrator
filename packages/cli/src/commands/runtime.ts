import { readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import {
  ConfigNotFoundError,
  loadConfigWithPath,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@composio/ao-core";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  appendStringOption,
  resolveRuntimeOverride,
  type RuntimeOverrideFlagOptions,
} from "../lib/runtime-overrides.js";

type RawConfig = Record<string, unknown>;
type RawProjectConfig = Record<string, unknown>;

interface RuntimeSetOptions {
  config?: string;
  image?: string;
  cpus?: string;
  memory?: string;
  gpus?: string;
  readOnly?: boolean;
  network?: string;
  capDrop?: string[];
  tmpfs?: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRawConfig(path: string): RawConfig {
  const parsed = yamlParse(readFileSync(path, "utf-8"));
  return isPlainObject(parsed) ? parsed : {};
}

function writeRawConfig(path: string, rawConfig: RawConfig): void {
  writeFileSync(path, yamlStringify(rawConfig, { indent: 2 }), "utf-8");
}

function getRawProjects(rawConfig: RawConfig): Record<string, RawProjectConfig> {
  if (!isPlainObject(rawConfig["projects"])) {
    rawConfig["projects"] = {};
  }
  return rawConfig["projects"] as Record<string, RawProjectConfig>;
}

function getRawDefaults(rawConfig: RawConfig): Record<string, unknown> {
  if (!isPlainObject(rawConfig["defaults"])) {
    rawConfig["defaults"] = {};
  }
  return rawConfig["defaults"] as Record<string, unknown>;
}

function getProjectOrExit(config: OrchestratorConfig, projectId: string): ProjectConfig {
  const project = config.projects[projectId];
  if (project) return project;

  console.error(
    chalk.red(
      `Project "${projectId}" not found. Available projects: ${Object.keys(config.projects).join(", ")}`,
    ),
  );
  process.exit(1);
}

function hasConfigFlags(opts: RuntimeSetOptions): boolean {
  return Boolean(
    opts.config ||
    opts.image ||
    opts.cpus ||
    opts.memory ||
    opts.gpus ||
    opts.readOnly ||
    opts.network ||
    (opts.capDrop && opts.capDrop.length > 0) ||
    (opts.tmpfs && opts.tmpfs.length > 0),
  );
}

function toRuntimeOverrideOptions(
  runtime: string,
  opts: RuntimeSetOptions,
): RuntimeOverrideFlagOptions {
  return {
    runtime,
    runtimeConfig: opts.config,
    runtimeImage: opts.image,
    runtimeCpus: opts.cpus,
    runtimeMemory: opts.memory,
    runtimeGpus: opts.gpus,
    runtimeReadOnly: opts.readOnly,
    runtimeNetwork: opts.network,
    runtimeCapDrop: opts.capDrop,
    runtimeTmpfs: opts.tmpfs,
  };
}

function runtimeConfigImage(runtimeConfig: unknown): string | undefined {
  if (!isPlainObject(runtimeConfig)) return undefined;
  const image = runtimeConfig["image"];
  return typeof image === "string" && image.trim().length > 0 ? image : undefined;
}

function printProjectRuntimeSummary(
  projectId: string,
  project: ProjectConfig,
  rawProject: RawProjectConfig | undefined,
  defaultRuntime: string,
): void {
  const configuredRuntime =
    typeof rawProject?.["runtime"] === "string" ? rawProject["runtime"] : null;
  const effectiveRuntime = project.runtime ?? defaultRuntime;
  const image = runtimeConfigImage(rawProject?.["runtimeConfig"]);
  const label = configuredRuntime ? configuredRuntime : `inherit (${effectiveRuntime})`;
  const suffix = image ? ` image=${image}` : "";
  console.log(`  ${projectId}: ${chalk.dim(label)}${suffix}`);
}

function withLoadedConfig<T>(
  handler: (ctx: {
    config: OrchestratorConfig;
    path: string;
    rawConfig: RawConfig;
  }) => Promise<T> | T,
): Promise<T> {
  return Promise.resolve()
    .then(async () => {
      const { config, path } = loadConfigWithPath();
      const rawConfig = readRawConfig(path);
      return handler({ config, path, rawConfig });
    })
    .catch((err) => {
      if (err instanceof ConfigNotFoundError) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
      throw err;
    });
}

export function registerRuntime(program: Command): void {
  const runtime = program.command("runtime").description("Inspect or update configured runtimes");

  runtime
    .command("show")
    .description("Show configured runtime defaults and project overrides")
    .argument("[project]", "Project ID to inspect")
    .action(async (projectId?: string) => {
      await withLoadedConfig(({ config, path, rawConfig }) => {
        const rawProjects = getRawProjects(rawConfig);

        if (projectId) {
          const project = getProjectOrExit(config, projectId);
          const rawProject = rawProjects[projectId];
          const configuredRuntime =
            typeof rawProject?.["runtime"] === "string" ? rawProject["runtime"] : "<inherit>";
          const effectiveRuntime = project.runtime ?? config.defaults.runtime;
          const runtimeConfig = isPlainObject(rawProject?.["runtimeConfig"])
            ? rawProject["runtimeConfig"]
            : undefined;

          console.log(chalk.bold(projectId));
          console.log(`  Config:            ${chalk.dim(path)}`);
          console.log(`  Configured runtime: ${chalk.dim(configuredRuntime)}`);
          console.log(`  Effective runtime:  ${chalk.dim(effectiveRuntime)}`);
          if (runtimeConfig) {
            console.log("  runtimeConfig:");
            console.log(
              JSON.stringify(runtimeConfig, null, 2)
                .split("\n")
                .map((line) => `    ${line}`)
                .join("\n"),
            );
          } else {
            console.log(`  runtimeConfig:      ${chalk.dim("<none>")}`);
          }
          return;
        }

        console.log(chalk.bold("Runtime configuration"));
        console.log(`  Config:           ${chalk.dim(path)}`);
        console.log(`  Default runtime:  ${chalk.dim(config.defaults.runtime)}`);
        console.log("  Projects:");
        for (const id of Object.keys(config.projects).sort()) {
          printProjectRuntimeSummary(
            id,
            config.projects[id],
            rawProjects[id],
            config.defaults.runtime,
          );
        }
      });
    });

  runtime
    .command("set")
    .description("Set the default runtime or a project-specific runtime override")
    .argument("<runtime>", "Runtime name to set (tmux, docker, process, ...)")
    .argument("[project]", "Optional project ID; omit to update defaults.runtime")
    .option("--config <json>", "Merge JSON into project runtimeConfig")
    .option("--image <image>", "Set project runtimeConfig.image")
    .option("--cpus <cpus>", "Set project runtimeConfig.limits.cpus")
    .option("--memory <memory>", "Set project runtimeConfig.limits.memory")
    .option("--gpus <gpus>", "Set project runtimeConfig.limits.gpus")
    .option("--read-only", "Set project runtimeConfig.readOnlyRoot=true")
    .option("--network <network>", "Set project runtimeConfig.network")
    .option("--cap-drop <cap>", "Append project runtimeConfig.capDrop entry", appendStringOption)
    .option("--tmpfs <mount>", "Append project runtimeConfig.tmpfs entry", appendStringOption)
    .action(async (runtimeName: string, projectId: string | undefined, opts: RuntimeSetOptions) => {
      await withLoadedConfig(({ config, path, rawConfig }) => {
        if (!projectId) {
          if (hasConfigFlags(opts)) {
            console.error(
              chalk.red(
                "Runtime config flags require a project argument; defaults only support runtime.",
              ),
            );
            process.exit(1);
          }

          const rawDefaults = getRawDefaults(rawConfig);
          rawDefaults["runtime"] = runtimeName;
          writeRawConfig(path, rawConfig);

          console.log(chalk.green(`Set defaults.runtime = ${runtimeName}`));
          if (runtimeName === "docker") {
            console.log(
              chalk.yellow(
                "Each project still needs runtimeConfig.image before Docker sessions can start.",
              ),
            );
          }
          return;
        }

        const project = getProjectOrExit(config, projectId);
        const rawProjects = getRawProjects(rawConfig);
        const rawProject = rawProjects[projectId] ?? {};
        rawProjects[projectId] = rawProject;

        const runtimeOverride = resolveRuntimeOverride(
          config,
          project,
          toRuntimeOverrideOptions(runtimeName, opts),
        );
        const effectiveRuntimeConfig = runtimeOverride.effectiveRuntimeConfig;

        if (runtimeName !== "docker" && hasConfigFlags(opts)) {
          console.error(
            chalk.red(
              "Runtime config flags are currently supported only when setting runtime=docker.",
            ),
          );
          process.exit(1);
        }

        if (runtimeName === "docker" && !runtimeConfigImage(effectiveRuntimeConfig)) {
          console.error(
            chalk.red(
              `Project "${projectId}" needs runtimeConfig.image when runtime is docker. Use --image or set it in config first.`,
            ),
          );
          process.exit(1);
        }

        rawProject["runtime"] = runtimeName;
        if (effectiveRuntimeConfig && Object.keys(effectiveRuntimeConfig).length > 0) {
          rawProject["runtimeConfig"] = effectiveRuntimeConfig;
        } else {
          delete rawProject["runtimeConfig"];
        }

        if (runtimeName !== "docker") {
          delete rawProject["runtimeConfig"];
        }

        writeRawConfig(path, rawConfig);

        console.log(chalk.green(`Set runtime for project "${projectId}" = ${runtimeName}`));
        if (runtimeName === "docker" && effectiveRuntimeConfig) {
          console.log(chalk.dim(`  runtimeConfig: ${JSON.stringify(effectiveRuntimeConfig)}`));
        }
      });
    });

  runtime
    .command("clear")
    .description("Clear the default runtime or a project-specific runtime override")
    .argument("[project]", "Optional project ID; omit to clear defaults.runtime")
    .action(async (projectId?: string) => {
      await withLoadedConfig(({ config, path, rawConfig }) => {
        if (!projectId) {
          const rawDefaults = getRawDefaults(rawConfig);
          delete rawDefaults["runtime"];
          writeRawConfig(path, rawConfig);
          console.log(
            chalk.green("Cleared defaults.runtime; effective default falls back to tmux."),
          );
          return;
        }

        getProjectOrExit(config, projectId);
        const rawProjects = getRawProjects(rawConfig);
        const rawProject = rawProjects[projectId] ?? {};
        delete rawProject["runtime"];
        delete rawProject["runtimeConfig"];
        rawProjects[projectId] = rawProject;
        writeRawConfig(path, rawConfig);
        console.log(
          chalk.green(
            `Cleared runtime override for project "${projectId}"; it now inherits ${config.defaults.runtime}.`,
          ),
        );
      });
    });
}
