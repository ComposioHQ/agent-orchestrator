/**
 * Portfolio registry — global-config-backed project projection plus user preferences.
 *
 * The global config is the canonical source of truth for which projects exist.
 * Preferences provide a lightweight UI overlay for ordering, pinning, visibility,
 * and display names.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import type {
  PortfolioProject,
  PortfolioPreferences,
  PortfolioRegistered,
} from "./types.js";
import {
  getPortfolioDir,
  getPreferencesPath,
  getRegisteredPath,
  generateSessionPrefix,
} from "./paths.js";
import {
  getGlobalConfigPath,
  loadGlobalConfig,
  loadLocalProjectConfig,
  registerProjectInGlobalConfig,
  saveGlobalConfig,
} from "./global-config.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { loadConfig } from "./config.js";

function normalizePath(path: string): string {
  return resolve(path);
}

/** Load registered projects from registered.json (legacy compatibility only). */
export function loadRegistered(): PortfolioRegistered {
  const path = getRegisteredPath();
  if (!existsSync(path)) {
    return { version: 1, projects: [] };
  }
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as PortfolioRegistered;
  } catch {
    return { version: 1, projects: [] };
  }
}

/** Save registered projects to registered.json (legacy compatibility only). */
export function saveRegistered(reg: PortfolioRegistered): void {
  const dir = getPortfolioDir();
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(getRegisteredPath(), JSON.stringify(reg, null, 2));
}

/** Load portfolio preferences from preferences.json */
export function loadPreferences(): PortfolioPreferences {
  const path = getPreferencesPath();
  if (!existsSync(path)) {
    return { version: 1 };
  }
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as PortfolioPreferences;
  } catch {
    return { version: 1 };
  }
}

/** Save portfolio preferences to preferences.json */
export function savePreferences(prefs: PortfolioPreferences): void {
  const dir = getPortfolioDir();
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(getPreferencesPath(), JSON.stringify(prefs, null, 2));
}

function applyPreferences(
  projects: PortfolioProject[],
  preferences: PortfolioPreferences,
): PortfolioProject[] {
  const projectMap = new Map(projects.map((project) => [project.id, project]));

  if (preferences.projects) {
    for (const [id, prefs] of Object.entries(preferences.projects)) {
      const project = projectMap.get(id);
      if (!project) continue;

      if (prefs.pinned !== undefined) project.pinned = prefs.pinned;
      if (prefs.enabled !== undefined) project.enabled = prefs.enabled;
      if (prefs.displayName) project.name = prefs.displayName;
    }
  }

  const orderMap = new Map<string, number>();
  if (preferences.projectOrder) {
    for (let i = 0; i < preferences.projectOrder.length; i++) {
      orderMap.set(preferences.projectOrder[i], i);
    }
  }

  return [...projectMap.values()].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;

    const orderA = orderMap.get(a.id) ?? Infinity;
    const orderB = orderMap.get(b.id) ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;

    return a.name.localeCompare(b.name);
  });
}

function projectFromGlobalConfig(): PortfolioProject[] {
  const globalConfig = loadGlobalConfig();
  if (!globalConfig) return [];

  const globalConfigPath = getGlobalConfigPath();
  return Object.entries(globalConfig.projects).map(([id, entry]) => ({
    id,
    name: (typeof entry.name === "string" && entry.name.length > 0) ? entry.name : id,
    configPath: globalConfigPath,
    configProjectKey: id,
    repoPath: entry.path,
    repo: typeof entry.repo === "string" ? entry.repo : undefined,
    defaultBranch: typeof entry.defaultBranch === "string" ? entry.defaultBranch : undefined,
    sessionPrefix:
      typeof entry.sessionPrefix === "string" && entry.sessionPrefix.length > 0
        ? entry.sessionPrefix
        : generateSessionPrefix(id),
    source: "config",
    enabled: true,
    pinned: false,
    lastSeenAt: new Date().toISOString(),
  }));
}

function fallbackPortfolioFromLoadedConfig(): PortfolioProject[] {
  try {
    const config = loadConfig();
    return Object.entries(config.projects).map(([id, project]) => ({
      id,
      name: project.name ?? id,
      configPath: config.configPath,
      configProjectKey: id,
      repoPath: project.path,
      repo: project.repo,
      defaultBranch: project.defaultBranch,
      sessionPrefix: project.sessionPrefix ?? generateSessionPrefix(id),
      source: "config",
      enabled: true,
      pinned: false,
      lastSeenAt: new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

/**
 * Backward-compatible alias for callers that previously treated "discovered"
 * projects as the portfolio base. Projects are now projected from the
 * canonical registry, so discovery simply returns that projection.
 */
export function discoverProjects(): PortfolioProject[] {
  return projectFromGlobalConfig();
}

/**
 * Build the portfolio directly from the canonical global registry, with
 * preferences layered on top. Falls back to the currently loaded config when
 * no global config exists yet.
 */
export function getPortfolio(): PortfolioProject[] {
  const preferences = loadPreferences();
  const projects = projectFromGlobalConfig();

  if (projects.length > 0) {
    return applyPreferences(projects, preferences);
  }

  return applyPreferences(fallbackPortfolioFromLoadedConfig(), preferences);
}

/** Register a project into the canonical global config registry. */
export function registerProject(repoPath: string, configProjectKey?: string): void {
  const normalizedRepoPath = normalizePath(repoPath);
  const localConfig = loadLocalProjectConfig(normalizedRepoPath);
  if (!localConfig) {
    throw new Error(`No local project config found at ${normalizedRepoPath}`);
  }

  const projectId = configProjectKey ?? basename(normalizedRepoPath);
  registerProjectInGlobalConfig(projectId, projectId, normalizedRepoPath, localConfig);
}

/** Remove a project from the canonical global config registry. */
export function unregisterProject(projectId: string): void {
  const globalConfig = loadGlobalConfig();
  if (!globalConfig?.projects[projectId]) return;

  delete globalConfig.projects[projectId];
  if (globalConfig.projectOrder) {
    globalConfig.projectOrder = globalConfig.projectOrder.filter((id) => id !== projectId);
    if (globalConfig.projectOrder.length === 0) {
      delete globalConfig.projectOrder;
    }
  }

  saveGlobalConfig(globalConfig);
}

/** Refresh is a no-op for the global-registry-backed portfolio. */
export function refreshProject(_projectId: string, _configPath: string): void {
  // Canonical portfolio entries are read directly from global config, so there
  // is no separate last-seen registry to update.
}
