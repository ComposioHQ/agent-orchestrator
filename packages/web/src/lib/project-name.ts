import { cache } from "react";
import { loadConfig } from "@composio/ao-core";

export interface ProjectInfo {
  id: string;
  name: string;
}

export const getProjectName = cache((): string => {
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

export const getPrimaryProjectId = cache((): string => {
  try {
    const config = loadConfig();
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) return firstKey;
  } catch {
    // Config not available
  }
  return "ao";
});

export const getAllProjects = cache((): ProjectInfo[] => {
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
