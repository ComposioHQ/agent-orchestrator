import "server-only";

import { cache } from "react";
import { getGlobalConfigPath, loadConfig } from "@aoagents/ao-core";

export interface ProjectInfo {
  id: string;
  name: string;
  sessionPrefix?: string;
  resolveError?: string;
}

export const getProjectName = cache((): string => {
  try {
    const config = loadConfig(getGlobalConfigPath());
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
    const config = loadConfig(getGlobalConfigPath());
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) return firstKey;
  } catch {
    // Config not available
  }
  return "ao";
});

export const getAllProjects = cache((): ProjectInfo[] => {
  try {
    const config = loadConfig(getGlobalConfigPath());
    return [
      ...Object.entries(config.projects).map(([id, project]) => ({
        id,
        name: project.name ?? id,
        sessionPrefix: project.sessionPrefix ?? id,
      })),
      ...Object.entries(config.degradedProjects).map(([id, project]) => ({
        id,
        name: id,
        sessionPrefix: id,
        resolveError: project.resolveError,
      })),
    ];
  } catch {
    return [];
  }
});
