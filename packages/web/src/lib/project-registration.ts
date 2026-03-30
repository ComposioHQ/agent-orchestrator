import { resolve } from "node:path";
import {
  getPortfolio,
  loadPreferences,
  registerProject,
  savePreferences,
} from "@composio/ao-core";

function normalizePath(path: string): string {
  return resolve(path);
}

export function invalidatePortfolioCache(): void {
  const globalForPortfolio = globalThis as typeof globalThis & {
    _aoPortfolioCache?: unknown;
  };
  delete globalForPortfolio._aoPortfolioCache;
}

export function registerAndResolveProject(
  repoPath: string,
  options?: {
    configProjectKey?: string;
    displayName?: string;
  },
) {
  const normalizedRepoPath = normalizePath(repoPath);
  registerProject(normalizedRepoPath, options?.configProjectKey);
  invalidatePortfolioCache();

  const project = getPortfolio().find(
    (candidate) =>
      normalizePath(candidate.repoPath) === normalizedRepoPath &&
      (!options?.configProjectKey || candidate.configProjectKey === options.configProjectKey),
  );

  if (!project) {
    throw new Error(`Project was registered, but could not be resolved at ${normalizedRepoPath}`);
  }

  if (options?.displayName && options.displayName !== project.name) {
    const preferences = loadPreferences();
    preferences.projects ??= {};
    preferences.projects[project.id] = {
      ...preferences.projects[project.id],
      displayName: options.displayName,
    };
    savePreferences(preferences);
    invalidatePortfolioCache();
    return {
      ...project,
      name: options.displayName,
    };
  }

  return project;
}
