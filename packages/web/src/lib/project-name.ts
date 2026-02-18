import { loadConfig } from "@composio/ao-core";

/**
 * Load the primary project name from config.
 * Falls back to "ao" if config is unavailable.
 */
export function getProjectName(): string {
  try {
    const config = loadConfig();
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) {
      return config.projects[firstKey].name ?? firstKey;
    }
  } catch {
    // Config not available
  }
  return "ao";
}
