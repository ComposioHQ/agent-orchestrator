/**
 * Portfolio project config resolution with caching.
 *
 * Resolves a PortfolioProject to its full OrchestratorConfig + ProjectConfig.
 * Caches loaded configs by configPath to avoid redundant YAML parsing.
 */

import type { PortfolioProject, OrchestratorConfig, ProjectConfig } from "./types.js";
import { loadConfig } from "./config.js";

const CACHE_TTL_MS = 30_000;
const configCache = new Map<string, { config: OrchestratorConfig; expiresAt: number }>();

export function resolveProjectConfig(entry: PortfolioProject): { config: OrchestratorConfig; project: ProjectConfig } | null {
  try {
    const cached = configCache.get(entry.configPath);
    let config: OrchestratorConfig;
    if (cached && Date.now() < cached.expiresAt) {
      config = cached.config;
    } else {
      config = loadConfig(entry.configPath);
      configCache.set(entry.configPath, { config, expiresAt: Date.now() + CACHE_TTL_MS });
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
