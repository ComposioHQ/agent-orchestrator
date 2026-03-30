/**
 * Global config registry — manages ~/.agent-orchestrator/config.yaml
 *
 * This file stores the project registry (identity + shadow copies)
 * and daemon-level settings. It is the source of truth for which
 * projects exist and how to reach them from anywhere.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type {
  GlobalConfig,
  ProjectRegistryEntry,
  ProjectShadow,
  ProjectConfig,
} from "./types.js";

const GLOBAL_CONFIG_DIR = ".agent-orchestrator";
const GLOBAL_CONFIG_FILE = "config.yaml";

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const ProjectRegistryEntrySchema = z.object({
  name: z.string(),
  id: z.string(),
  path: z.string(),
  repo: z.string(),
  defaultBranch: z.string().default("main"),
  configMode: z.enum(["hybrid", "global-only"]),
  localConfigPath: z.string().optional(),
  sessionPrefix: z.string().optional(),
});

const GlobalConfigSchema = z.object({
  version: z.number().default(1),
  projects: z.record(ProjectRegistryEntrySchema).default({}),
  shadows: z.record(z.record(z.unknown())).default({}),
  daemon: z
    .object({
      port: z.number().optional(),
      terminalPort: z.number().optional(),
      directTerminalPort: z.number().optional(),
      readyThresholdMs: z.number().optional(),
    })
    .default({}),
  notifiers: z.record(z.record(z.unknown())).optional(),
  notificationRouting: z.record(z.array(z.string())).optional(),
  reactions: z.record(z.record(z.unknown())).optional(),
  defaults: z.record(z.unknown()).optional(),
});

// =============================================================================
// PUBLIC API
// =============================================================================

/** Get the path to the global config file. */
export function getGlobalConfigPath(homeOverride?: string): string {
  const home = homeOverride ?? homedir();
  return join(home, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE);
}

/** Get the global config directory. */
export function getGlobalConfigDir(homeOverride?: string): string {
  const home = homeOverride ?? homedir();
  return join(home, GLOBAL_CONFIG_DIR);
}

/** Check if global config exists. */
export function globalConfigExists(homeOverride?: string): boolean {
  return existsSync(getGlobalConfigPath(homeOverride));
}

/** Load the global config, returning defaults if file doesn't exist. */
export function loadGlobalConfig(homeOverride?: string): GlobalConfig {
  const configPath = getGlobalConfigPath(homeOverride);

  if (!existsSync(configPath)) {
    return {
      version: 1,
      projects: {},
      shadows: {},
      daemon: {},
    };
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  const validated = GlobalConfigSchema.parse(parsed);
  return validated as GlobalConfig;
}

/** Save the global config to disk. */
export function saveGlobalConfig(config: GlobalConfig, homeOverride?: string): void {
  const configPath = getGlobalConfigPath(homeOverride);
  const dir = getGlobalConfigDir(homeOverride);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, stringifyYaml(config, { indent: 2 }), "utf-8");
}

/** Register a project in the global config. */
export function registerProject(
  globalConfig: GlobalConfig,
  entry: ProjectRegistryEntry,
  shadow?: ProjectShadow,
): GlobalConfig {
  const updated: GlobalConfig = {
    ...globalConfig,
    projects: { ...globalConfig.projects, [entry.id]: entry },
    shadows: { ...globalConfig.shadows },
  };
  if (shadow) {
    updated.shadows[entry.id] = shadow;
  }
  return updated;
}

/** Unregister a project from the global config. */
export function unregisterProject(
  globalConfig: GlobalConfig,
  projectId: string,
): GlobalConfig {
  const { [projectId]: _removed, ...remainingProjects } = globalConfig.projects;
  const { [projectId]: _removedShadow, ...remainingShadows } = globalConfig.shadows;
  return {
    ...globalConfig,
    projects: remainingProjects,
    shadows: remainingShadows,
  };
}

/** Identity fields that belong in the registry entry, not the shadow. */
const IDENTITY_FIELDS = new Set([
  "name",
  "repo",
  "path",
  "defaultBranch",
  "sessionPrefix",
]);

/**
 * Extract a shadow copy from a ProjectConfig.
 * Strips identity fields to produce behavior-only config.
 */
export function extractShadow(project: ProjectConfig): ProjectShadow {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(project)) {
    if (!IDENTITY_FIELDS.has(key) && value !== undefined) {
      result[key] = value;
    }
  }
  return result as ProjectShadow;
}

/**
 * Check if a specific project is registered in the global config.
 */
export function isProjectRegistered(
  globalConfig: GlobalConfig,
  projectId: string,
): boolean {
  return projectId in globalConfig.projects;
}
