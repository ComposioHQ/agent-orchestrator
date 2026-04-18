import "server-only";

import { cache } from "react";
import { loadConfig, loadPreferences, getPortfolio, isPortfolioEnabled } from "@aoagents/ao-core";

export interface ProjectInfo {
  id: string;
  name: string;
  sessionPrefix?: string;
  degraded?: boolean;
  degradedReason?: string;
}

function getPrimaryProject(): ProjectInfo | null {
  if (isPortfolioEnabled()) {
    try {
      const prefs = loadPreferences();
      if (prefs.defaultProjectId) {
        const portfolio = getPortfolio();
        const found = portfolio.find((p) => p.id === prefs.defaultProjectId);
        if (found && found.enabled !== false) {
          return {
            id: found.id,
            name: found.name,
            ...(found.sessionPrefix ? { sessionPrefix: found.sessionPrefix } : {}),
            ...(found.degraded !== undefined ? { degraded: found.degraded } : {}),
            ...(found.degradedReason ? { degradedReason: found.degradedReason } : {}),
          };
        }
      }
    } catch {
      // Portfolio not available
    }
  }

  try {
    const config = loadConfig();
    const entry = Object.entries(config.projects).find(([, project]) => project.enabled !== false);
    if (entry) {
      const [id, project] = entry;
      return {
        id,
        name: project.name ?? id,
        ...(project.sessionPrefix ? { sessionPrefix: project.sessionPrefix } : {}),
        ...(typeof project.resolveError === "string" && project.resolveError.length > 0
          ? { degraded: true, degradedReason: project.resolveError }
          : {}),
      };
    }
  } catch {
    // Config not available
  }
  return null;
}

export const getPrimaryProjectId = cache((): string => {
  return getPrimaryProject()?.id ?? "ao";
});

export const getProjectName = cache((): string => {
  return getPrimaryProject()?.name ?? "ao";
});

export const getAllProjects = cache((): ProjectInfo[] => {
  if (isPortfolioEnabled()) {
    try {
      const portfolio = getPortfolio();
      if (portfolio.length > 0) {
        return portfolio
          .filter((project) => project.enabled !== false)
          .map((p) => ({
            id: p.id,
            name: p.name,
            ...(p.sessionPrefix ? { sessionPrefix: p.sessionPrefix } : {}),
            ...(p.degraded !== undefined ? { degraded: p.degraded } : {}),
            ...(p.degradedReason ? { degradedReason: p.degradedReason } : {}),
          }));
      }
    } catch {
      // Portfolio not available
    }
  }

  try {
    const config = loadConfig();
    return Object.entries(config.projects)
      .filter(([, project]) => project.enabled !== false)
      .map(([id, project]) => ({
        id,
        name: project.name ?? id,
        ...(project.sessionPrefix ? { sessionPrefix: project.sessionPrefix } : {}),
        ...(typeof project.resolveError === "string" && project.resolveError.length > 0
          ? { degraded: true, degradedReason: project.resolveError }
          : {}),
      }));
  } catch {
    return [];
  }
});
