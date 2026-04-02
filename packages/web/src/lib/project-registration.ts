import { resolve } from "node:path";
import {
  getPortfolio,
  registerProject,
  updatePreferences,
} from "@composio/ao-core";
import { stopPortfolioBackgroundRefresh } from "./portfolio-services";
import { invalidateServicesCache } from "./services";

function normalizePath(path: string): string {
  return resolve(path);
}

export function invalidatePortfolioCache(): void {
  const globalForPortfolio = globalThis as typeof globalThis & {
    _aoPortfolioCache?: unknown;
    _aoPortfolioRefreshTimer?: ReturnType<typeof setInterval>;
  };
  delete globalForPortfolio._aoPortfolioCache;
  stopPortfolioBackgroundRefresh();
}

export function invalidateProjectCaches(): void {
  invalidatePortfolioCache();
  invalidateServicesCache();
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
  invalidateProjectCaches();

  const project = getPortfolio().find(
    (candidate) =>
      normalizePath(candidate.repoPath) === normalizedRepoPath &&
      (!options?.configProjectKey || candidate.configProjectKey === options.configProjectKey),
  );

  if (!project) {
    throw new Error(`Project was registered, but could not be resolved at ${normalizedRepoPath}`);
  }

  if (options?.displayName && options.displayName !== project.name) {
    updatePreferences((preferences) => {
      preferences.projects ??= {};
      preferences.projects[project.id] = {
        ...preferences.projects[project.id],
        displayName: options.displayName,
      };
    });
    invalidateProjectCaches();
    return {
      ...project,
      name: options.displayName,
    };
  }

  return project;
}
