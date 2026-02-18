import { cache } from "react";
import { loadConfig } from "@composio/ao-core";

/**
 * Load the primary project name from config.
 * Falls back to "ao" if config is unavailable.
 *
 * Wrapped with React.cache() to deduplicate filesystem reads
 * within a single server render pass (layout + page + icon all
 * call this, but config is only read once per request).
 */
export const getProjectName = cache((): string => {
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
});
