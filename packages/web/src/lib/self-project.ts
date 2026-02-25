import { cache } from "react";
import { loadConfig } from "@composio/ao-core";
import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Detect which project ID owns the agent-orchestrator dashboard itself.
 * Searches config for a project whose resolved path contains "agent-orchestrator".
 * Falls back to the first project if no match is found.
 */
export const getSelfProjectId = cache((): string => {
  try {
    const config = loadConfig();
    const home = homedir();

    for (const [key, project] of Object.entries(config.projects)) {
      const resolved = project.path.startsWith("~")
        ? resolve(home, project.path.slice(2))
        : resolve(project.path);
      if (resolved.includes("agent-orchestrator")) {
        return key;
      }
    }

    // Fallback: first project
    const firstKey = Object.keys(config.projects)[0];
    return firstKey ?? "";
  } catch {
    return "";
  }
});
