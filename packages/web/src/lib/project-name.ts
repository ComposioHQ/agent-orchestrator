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
    const keys = Object.keys(config.projects);
    if (keys.length === 1) {
      const name = config.projects[keys[0]].name ?? keys[0];
      return name || keys[0] || "ao";
    }
    if (keys.length > 1) {
      return keys.map((k) => config.projects[k].name ?? k).join(" \u00b7 ");
    }
  } catch {
    // Config not available
  }
  return "ao";
});
