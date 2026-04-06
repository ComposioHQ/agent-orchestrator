import { cache } from "react";
import { loadConfig } from "@composio/ao-core";

<<<<<<< HEAD
export interface ProjectInfo {
  id: string;
  name: string;
  sessionPrefix?: string;
}

=======
/**
 * Load the primary project name from config.
 * Falls back to "ao" if config is unavailable.
 *
 * Wrapped with React.cache() to deduplicate filesystem reads
 * within a single server render pass (layout + page + icon all
 * call this, but config is only read once per request).
 */
>>>>>>> parent of c7c04c14 (feat(web): Project-scoped dashboard with sidebar navigation (#381))
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
<<<<<<< HEAD

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
      sessionPrefix: project.sessionPrefix ?? id,
    }));
  } catch {
    return [];
  }
});
=======
>>>>>>> parent of c7c04c14 (feat(web): Project-scoped dashboard with sidebar navigation (#381))
