/**
 * Portfolio registry — discovery, registration, and preferences for cross-project aggregation.
 *
 * Discovery: scans ~/.agent-orchestrator/ for project directories matching {12hexchars}-{id}.
 * Registration: explicit `ao project add` entries stored in registered.json.
 * Preferences: user overlay (pinning, ordering, enabled) stored in preferences.json.
 *
 * getPortfolio() merges all three sources into a unified PortfolioProject[].
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import type {
  PortfolioProject,
  PortfolioPreferences,
  PortfolioRegistered,
  OrchestratorConfig,
  ProjectConfig,
} from "./types.js";
import {
  getAoBaseDir,
  getPortfolioDir,
  getPreferencesPath,
  getRegisteredPath,
  generateSessionPrefix,
} from "./paths.js";
import { loadConfig, findConfigFile } from "./config.js";
import { getGlobalConfigPath } from "./global-config.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { derivePortfolioProjectId } from "./portfolio-routing.js";

/** Pattern for AO project directories: 12 hex chars followed by a dash and an id */
const DIR_PATTERN = /^[a-f0-9]{12}-.+$/;

// =============================================================================
// DISCOVERY — scan ~/.agent-orchestrator/ for project dirs
// =============================================================================

/**
 * Discover projects by scanning ~/.agent-orchestrator/ directories.
 * Each directory matching {12hexchars}-{projectId} with a .origin file is a candidate.
 */
export function discoverProjects(): PortfolioProject[] {
  const baseDir = getAoBaseDir();
  if (!existsSync(baseDir)) return [];

  const entries = readdirSync(baseDir).sort();
  const projects: PortfolioProject[] = [];

  for (const entry of entries) {
    if (!DIR_PATTERN.test(entry)) continue;

    const entryPath = join(baseDir, entry);
    try {
      const stat = statSync(entryPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const originPath = join(entryPath, ".origin");
    if (!existsSync(originPath)) continue;

    let configPath: string;
    try {
      configPath = readFileSync(originPath, "utf-8").trim();
    } catch {
      continue;
    }

    // Extract projectId from directory name: everything after the first 13 chars (12 hex + dash)
    const projectId = entry.slice(13);

    let config: OrchestratorConfig | null = null;
    let projectConfig: ProjectConfig | undefined;
    let degraded = false;
    let _degradedReason: string | undefined;

    try {
      config = loadConfig(configPath);
      projectConfig = config.projects[projectId];
      if (!projectConfig) {
        // The config key may differ from the directory-level projectId.
        // Try to find a matching project by path basename.
        for (const [_key, pc] of Object.entries(config.projects)) {
          if (basename(pc.path) === projectId) {
            projectConfig = pc;
            break;
          }
        }
      }
    } catch {
      // .origin may point to a flat local config (post-migration to hybrid model).
      // Fall back to the global config for project metadata while keeping the
      // original configPath so the session-directory hash remains stable.
      try {
        const globalPath = getGlobalConfigPath();
        if (existsSync(globalPath) && globalPath !== configPath) {
          config = loadConfig(globalPath);
          projectConfig = config.projects[projectId];
          if (!projectConfig) {
            for (const [_key, pc] of Object.entries(config.projects)) {
              if (basename(pc.path) === projectId) {
                projectConfig = pc;
                break;
              }
            }
          }
        }
      } catch {
        // Global config also unavailable
      }

      if (!projectConfig) {
        degraded = true;
        _degradedReason = `Failed to load config at ${configPath}`;
      }
    }

    // Skip directories whose config can't be resolved at all — these are
    // stale test/dev artifacts, not real projects the user cares about.
    if (degraded) continue;

    const project: PortfolioProject = {
      id: projectId,
      name: projectConfig?.name || projectId,
      configPath,
      configProjectKey: projectConfig ? findConfigKey(config!, projectConfig) || projectId : projectId,
      repoPath: projectConfig?.path || entryPath,
      repo: projectConfig?.repo,
      defaultBranch: projectConfig?.defaultBranch,
      sessionPrefix: projectConfig?.sessionPrefix || generateSessionPrefix(projectId),
      source: "discovered",
      enabled: true,
      pinned: false,
      lastSeenAt: new Date().toISOString(),
    };

    projects.push(project);
  }

  // Deduplicate: after migration from local → global config, two directories
  // may exist for the same project (one hashed from the local config path, one
  // from the global config path). Keep the entry whose configPath is NOT the
  // global config — it has the stable project-path-based hash and contains the
  // legacy sessions. The global-config-based directory is an artefact of the
  // migration period and typically only holds the orchestrator session.
  const globalConfigPath = getGlobalConfigPath();
  const byRepoPath = new Map<string, PortfolioProject[]>();
  for (const project of projects) {
    const key = project.repoPath;
    const list = byRepoPath.get(key) ?? [];
    list.push(project);
    byRepoPath.set(key, list);
  }

  const deduped: PortfolioProject[] = [];
  for (const candidates of byRepoPath.values()) {
    if (candidates.length === 1) {
      deduped.push(candidates[0]);
    } else {
      // Prefer the entry whose configPath is the local config (not global)
      const local = candidates.find((c) => c.configPath !== globalConfigPath);
      deduped.push(local ?? candidates[0]);
    }
  }

  return deduped;
}

/** Find the config key for a given ProjectConfig within an OrchestratorConfig */
function findConfigKey(config: OrchestratorConfig, projectConfig: ProjectConfig): string | undefined {
  for (const [key, pc] of Object.entries(config.projects)) {
    if (pc === projectConfig) return key;
  }
  return undefined;
}

// =============================================================================
// REGISTERED — explicit project registration
// =============================================================================

/** Load registered projects from registered.json */
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

/** Save registered projects to registered.json */
export function saveRegistered(reg: PortfolioRegistered): void {
  const dir = getPortfolioDir();
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(getRegisteredPath(), JSON.stringify(reg, null, 2));
}

// =============================================================================
// PREFERENCES — user overlay
// =============================================================================

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

// =============================================================================
// PORTFOLIO — unified merge of discovered + registered + preferences
// =============================================================================

/**
 * Build the unified portfolio by merging discovered projects, registered projects,
 * and user preferences.
 *
 * Merge logic:
 * 1. Start with discovered projects (keyed by id)
 * 2. For each registered project not already discovered, resolve and add
 * 3. Apply preferences overlay (pinning, ordering, enabled, displayName)
 * 4. Sort: pinned first, then by preferences.projectOrder, then alphabetical
 */
export function getPortfolio(): PortfolioProject[] {
  const discovered = discoverProjects();
  const registered = loadRegistered();
  const preferences = loadPreferences();

  // Build map keyed by id
  const projectMap = new Map<string, PortfolioProject>();
  const existingIds = new Set<string>();

  // Step 1: Add discovered projects
  for (const project of discovered) {
    const id = derivePortfolioProjectId(project.id, existingIds);
    project.id = id;
    existingIds.add(id);
    projectMap.set(id, project);
  }

  // Step 2: Add registered projects not already discovered
  for (const reg of registered.projects) {
    // Try to find config directly at the registered path first, then fall back to findConfigFile.
    // This avoids findConfigFile picking up a parent/CWD config that doesn't cover this project.
    let configPath: string | null = null;
    for (const filename of ["agent-orchestrator.yaml", "agent-orchestrator.yml"]) {
      const candidate = resolve(reg.path, filename);
      if (existsSync(candidate)) {
        configPath = candidate;
        break;
      }
    }
    if (!configPath) {
      configPath = findConfigFile(reg.path);
    }
    if (!configPath) continue;

    let config: OrchestratorConfig;
    try {
      config = loadConfig(configPath);
    } catch {
      continue;
    }

    // Determine which project key to use
    const projectKeys = reg.configProjectKey
      ? [reg.configProjectKey]
      : Object.keys(config.projects);

    for (const key of projectKeys) {
      const pc = config.projects[key];
      if (!pc) continue;

      // Check if already discovered (match by configPath + key)
      const alreadyExists = Array.from(projectMap.values()).some(
        (p) => p.configPath === configPath && p.configProjectKey === key,
      );
      if (alreadyExists) continue;

      const id = derivePortfolioProjectId(key, existingIds);
      existingIds.add(id);

      const project: PortfolioProject = {
        id,
        name: pc.name || key,
        configPath,
        configProjectKey: key,
        repoPath: pc.path,
        repo: pc.repo,
        defaultBranch: pc.defaultBranch,
        sessionPrefix: pc.sessionPrefix || generateSessionPrefix(key),
        source: "registered",
        enabled: true,
        pinned: false,
        lastSeenAt: reg.addedAt,
      };

      projectMap.set(id, project);
    }
  }

  // Step 3: Apply preferences overlay
  if (preferences.projects) {
    for (const [id, prefs] of Object.entries(preferences.projects)) {
      const project = projectMap.get(id);
      if (!project) continue;

      if (prefs.pinned !== undefined) project.pinned = prefs.pinned;
      if (prefs.enabled !== undefined) project.enabled = prefs.enabled;
      if (prefs.displayName) project.name = prefs.displayName;
    }
  }

  // Step 4: Sort — pinned first, then by projectOrder, then alphabetical
  const orderMap = new Map<string, number>();
  if (preferences.projectOrder) {
    for (let i = 0; i < preferences.projectOrder.length; i++) {
      orderMap.set(preferences.projectOrder[i], i);
    }
  }

  const projects = Array.from(projectMap.values());
  projects.sort((a, b) => {
    // Pinned first
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;

    // Then by projectOrder
    const orderA = orderMap.get(a.id) ?? Infinity;
    const orderB = orderMap.get(b.id) ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;

    // Then alphabetical
    return a.name.localeCompare(b.name);
  });

  return projects;
}

// =============================================================================
// MUTATION HELPERS
// =============================================================================

/** Register a project by repo path (and optional config project key) */
export function registerProject(repoPath: string, configProjectKey?: string): void {
  const reg = loadRegistered();

  // Avoid duplicates
  const exists = reg.projects.some(
    (p) => p.path === repoPath && p.configProjectKey === configProjectKey,
  );
  if (exists) return;

  reg.projects.push({
    path: repoPath,
    configProjectKey,
    addedAt: new Date().toISOString(),
  });

  saveRegistered(reg);
}

/** Unregister a project by its portfolio ID */
export function unregisterProject(projectId: string): void {
  const portfolio = getPortfolio();
  const project = portfolio.find((p) => p.id === projectId);
  if (!project) return;

  const reg = loadRegistered();
  reg.projects = reg.projects.filter(
    (p) => !(p.path === project.repoPath && (p.configProjectKey === project.configProjectKey || !p.configProjectKey)),
  );

  saveRegistered(reg);
}

/** Refresh a project's lastSeenAt timestamp */
export function refreshProject(projectId: string, _configPath: string): void {
  const reg = loadRegistered();
  const portfolio = getPortfolio();
  const project = portfolio.find((p) => p.id === projectId);
  if (!project) return;

  const entry = reg.projects.find(
    (p) => p.path === project.repoPath && (p.configProjectKey === project.configProjectKey || !p.configProjectKey),
  );
  if (entry) {
    entry.addedAt = new Date().toISOString();
    saveRegistered(reg);
  }
}
