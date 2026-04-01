import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  isOldConfigFormat,
  loadGlobalConfig,
  loadLocalProjectConfig,
  registerProjectInGlobalConfig,
  saveGlobalConfig,
} from "@composio/ao-core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

interface LegacyProjectEntry {
  key: string;
  name: string;
  path: string;
  sessionPrefix?: string;
  behavior: Record<string, unknown>;
}

export interface LegacyMigrationResult {
  migrated: boolean;
  configProjectKey?: string;
}

function normalizePath(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(join(homedir(), path.slice(2)));
  }
  return resolve(path);
}

function parseLegacyProjectEntries(raw: Record<string, unknown>): LegacyProjectEntry[] {
  const projects = raw["projects"];
  if (!projects || typeof projects !== "object") return [];

  return Object.entries(projects as Record<string, unknown>)
    .flatMap(([key, value]) => {
      if (!value || typeof value !== "object") return [];

      const record = value as Record<string, unknown>;
      if (typeof record["path"] !== "string") return [];

      const behavior: Record<string, unknown> = {};
      for (const [field, fieldValue] of Object.entries(record)) {
        if (field === "name" || field === "path" || field === "sessionPrefix") continue;
        if (field.startsWith("_")) continue;
        behavior[field] = fieldValue;
      }

      return [
        {
          key,
          name: typeof record["name"] === "string" && record["name"] ? record["name"] : key,
          path: normalizePath(record["path"]),
          sessionPrefix:
            typeof record["sessionPrefix"] === "string" ? record["sessionPrefix"] : undefined,
          behavior,
        },
      ];
    });
}

function writeFlatLocalConfig(configPath: string, behavior: Record<string, unknown>): void {
  writeFileSync(configPath, stringifyYaml(behavior, { indent: 2 }), "utf-8");
}

function preserveSessionPrefix(projectId: string, sessionPrefix: string | undefined): void {
  if (!sessionPrefix) return;
  const globalConfig = loadGlobalConfig();
  if (!globalConfig?.projects[projectId]) return;

  globalConfig.projects[projectId] = {
    ...globalConfig.projects[projectId],
    sessionPrefix,
  };
  saveGlobalConfig(globalConfig);
}

export function migrateLegacyConfigForPortfolioRegistration(
  repoPath: string,
  configPath: string,
): LegacyMigrationResult {
  const rawContent = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(rawContent) as Record<string, unknown>;

  if (!isOldConfigFormat(parsed)) {
    return { migrated: false };
  }

  const normalizedRepoPath = normalizePath(repoPath);
  const matchingProjects = parseLegacyProjectEntries(parsed).filter(
    (project) => project.path === normalizedRepoPath,
  );

  if (matchingProjects.length === 0) {
    throw new Error(
      `This repository has an older AO config, but none of its project entries match ${normalizedRepoPath}.`,
    );
  }

  if (matchingProjects.length > 1) {
    const keys = matchingProjects.map((project) => project.key).join(", ");
    throw new Error(
      `This repository has an older AO config with multiple project entries for the same path.\n` +
        `File to edit: ${configPath}\n` +
        `Duplicate project keys: ${keys}\n` +
        `Portfolio mode supports exactly one portfolio entry per repo path.\n` +
        `Keep the one project key you want for ${normalizedRepoPath}, merge any settings you need from the others, remove the duplicate entries, then try again.`,
    );
  }

  const [project] = matchingProjects;
  const flatConfigPath = join(normalizedRepoPath, basename(configPath));

  writeFlatLocalConfig(flatConfigPath, project.behavior);

  const localConfig = loadLocalProjectConfig(normalizedRepoPath);
  if (!localConfig) {
    throw new Error(`Failed to migrate legacy config at ${normalizedRepoPath}.`);
  }

  registerProjectInGlobalConfig(project.key, project.name, normalizedRepoPath, localConfig);
  preserveSessionPrefix(project.key, project.sessionPrefix);

  return {
    migrated: true,
    configProjectKey: project.key,
  };
}
