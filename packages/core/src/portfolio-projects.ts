/**
 * Portfolio project config resolution with caching.
 *
 * Resolves a PortfolioProject to its full OrchestratorConfig + ProjectConfig.
 * Caches loaded configs by configPath to avoid redundant YAML parsing.
 */

import type { PortfolioProject, OrchestratorConfig, ProjectConfig } from "./types.js";
import { loadConfig } from "./config.js";

const configCache = new Map<string, OrchestratorConfig>();

export function resolveProjectConfig(entry: PortfolioProject): { config: OrchestratorConfig; project: ProjectConfig } | null {
  try {
    let config = configCache.get(entry.configPath);
    if (!config) {
      config = loadConfig(entry.configPath);
      configCache.set(entry.configPath, config);
    }
    const project = config.projects[entry.configProjectKey];
    if (!project) return null;
    return { config, project };
  } catch {
    return null;
  }
}

export function clearConfigCache(): void {
  configCache.clear();
}
