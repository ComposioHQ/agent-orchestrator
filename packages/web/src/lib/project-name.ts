import { cache } from "react";
import { loadConfig, loadPreferences, getPortfolio } from "@composio/ao-core";

export interface ProjectInfo {
  id: string;
  name: string;
}

export const getPrimaryProjectId = cache((): string => {
  try {
    const prefs = loadPreferences();
    if (prefs.defaultProjectId) {
      const portfolio = getPortfolio();
      const found = portfolio.find(p => p.id === prefs.defaultProjectId);
      if (found) return found.id;
    }
  } catch {
    // Portfolio not available
  }

  try {
    const config = loadConfig();
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) return firstKey;
  } catch {
    // Config not available
  }
  return "ao";
});

export const getProjectName = cache((): string => {
  try {
    const prefs = loadPreferences();
    if (prefs.defaultProjectId) {
      const portfolio = getPortfolio();
      const found = portfolio.find(p => p.id === prefs.defaultProjectId);
      if (found) return found.name;
    }
  } catch {
    // Portfolio not available
  }

  try {
    const config = loadConfig();
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) {
      const name = config.projects[firstKey].name ?? firstKey;
      return name || firstKey || "ao";
    }
  } catch {
    // Config not available
  }
  return "ao";
});

export const getAllProjects = cache((): ProjectInfo[] => {
  try {
    const portfolio = getPortfolio();
    if (portfolio.length > 0) {
      return portfolio.map(p => ({ id: p.id, name: p.name }));
    }
  } catch {
    // Portfolio not available
  }

  try {
    const config = loadConfig();
    return Object.entries(config.projects).map(([id, project]) => ({
      id,
      name: project.name ?? id,
    }));
  } catch {
    return [];
  }
});
