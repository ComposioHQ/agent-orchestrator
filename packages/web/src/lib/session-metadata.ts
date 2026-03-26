import { getSessionsDir } from "@composio/ao-core";

/**
 * Resolve sessions metadata directory from trusted config.
 * Returns null when configPath is unavailable/invalid.
 */
export function resolveSessionsDir(
  configPath: string,
  projectPath: string,
): string | null {
  try {
    return getSessionsDir(configPath, projectPath);
  } catch {
    return null;
  }
}
