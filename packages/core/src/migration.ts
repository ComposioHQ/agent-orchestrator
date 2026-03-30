/**
 * Migration — automatic one-way migration from single-project to multi-project format.
 *
 * Detects legacy configs (with `projects:` wrapper containing identity + behavior)
 * and splits them into:
 * - Global registry entries (identity: name, repo, path, defaultBranch)
 * - Shadow copies (behavior: agent, runtime, tracker, etc.)
 */

import { basename } from "node:path";
import type { GlobalConfig, ProjectRegistryEntry, ProjectShadow } from "./types.js";
import { generateSessionPrefix } from "./paths.js";

/** Identity fields that go into the registry entry. */
const IDENTITY_KEYS = new Set(["name", "repo", "path", "defaultBranch", "sessionPrefix"]);

/**
 * Check if a raw parsed config needs migration to multi-project format.
 * Migration is needed when:
 * - Config has a `projects` key (legacy wrapper format)
 * - The global config doesn't already have these specific projects registered
 */
export function needsMigration(
  raw: unknown,
  registeredProjectIds?: Set<string>,
): boolean {
  if (!raw || typeof raw !== "object") return false;
  if (!("projects" in raw)) return false;

  const projects = (raw as Record<string, unknown>)["projects"];
  if (!projects || typeof projects !== "object") return false;

  // If we have registered project IDs, check if any projects are new
  if (registeredProjectIds) {
    const projectKeys = Object.keys(projects as Record<string, unknown>);
    const hasNewProjects = projectKeys.some((key) => !registeredProjectIds.has(key));
    return hasNewProjects;
  }

  return true;
}

export interface MigrationResult {
  globalConfig: GlobalConfig;
}

/**
 * Migrate a legacy config to multi-project format.
 * Extracts project entries and shadow configs from the legacy format.
 */
export function migrateToMultiProject(
  legacyRaw: Record<string, unknown>,
  configPath: string,
): MigrationResult {
  const projects = (legacyRaw["projects"] ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  const globalConfig: GlobalConfig = {
    version: 1,
    projects: {},
    shadows: {},
    daemon: {},
  };

  // Extract daemon-level settings
  if (typeof legacyRaw["port"] === "number") {
    globalConfig.daemon.port = legacyRaw["port"];
  }
  if (typeof legacyRaw["terminalPort"] === "number") {
    globalConfig.daemon.terminalPort = legacyRaw["terminalPort"];
  }
  if (typeof legacyRaw["directTerminalPort"] === "number") {
    globalConfig.daemon.directTerminalPort = legacyRaw["directTerminalPort"];
  }
  if (typeof legacyRaw["readyThresholdMs"] === "number") {
    globalConfig.daemon.readyThresholdMs = legacyRaw["readyThresholdMs"];
  }

  // Extract global defaults
  if (legacyRaw["defaults"] && typeof legacyRaw["defaults"] === "object") {
    globalConfig.defaults = legacyRaw["defaults"] as Record<string, unknown>;
  }
  if (legacyRaw["notifiers"] && typeof legacyRaw["notifiers"] === "object") {
    globalConfig.notifiers = legacyRaw["notifiers"] as Record<
      string,
      Record<string, unknown>
    >;
  }
  if (
    legacyRaw["notificationRouting"] &&
    typeof legacyRaw["notificationRouting"] === "object"
  ) {
    globalConfig.notificationRouting = legacyRaw["notificationRouting"] as Record<
      string,
      string[]
    >;
  }
  if (legacyRaw["reactions"] && typeof legacyRaw["reactions"] === "object") {
    globalConfig.reactions = legacyRaw["reactions"] as Record<
      string,
      Record<string, unknown>
    >;
  }

  // Extract each project
  for (const [projectKey, projectRaw] of Object.entries(projects)) {
    const projectPath = (projectRaw["path"] as string) ?? "";
    const projectId = projectKey;

    const entry: ProjectRegistryEntry = {
      name: (projectRaw["name"] as string) ?? projectKey,
      id: projectId,
      path: projectPath,
      repo: (projectRaw["repo"] as string) ?? "",
      defaultBranch: (projectRaw["defaultBranch"] as string) ?? "main",
      configMode: "hybrid",
      localConfigPath: configPath,
      sessionPrefix:
        (projectRaw["sessionPrefix"] as string) ??
        generateSessionPrefix(basename(projectPath) || projectKey),
    };

    // Build shadow (everything except identity fields)
    const shadow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(projectRaw)) {
      if (!IDENTITY_KEYS.has(key)) {
        shadow[key] = value;
      }
    }

    globalConfig.projects[projectId] = entry;
    globalConfig.shadows[projectId] = shadow as ProjectShadow;
  }

  return { globalConfig };
}
