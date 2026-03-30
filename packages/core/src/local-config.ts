/**
 * Local config parser — handles the flattened behavior-only format.
 *
 * Local configs live in the project directory (agent-orchestrator.yaml)
 * and contain ONLY behavior settings (agent, runtime, permissions, etc.).
 * Identity fields (name, repo, path) live in the global registry.
 */

import type { ProjectShadow } from "./types.js";

/** Identity fields that belong in the global registry, not local config. */
const IDENTITY_FIELDS = new Set([
  "name",
  "repo",
  "path",
  "defaultBranch",
  "sessionPrefix",
]);

/**
 * Detect if a parsed YAML object is a local (flat) config.
 * Local configs have NO `projects` key — they are behavior-only.
 */
export function isLocalConfig(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  return !("projects" in raw);
}

/**
 * Parse a local config, stripping identity fields.
 * Returns a ProjectShadow (behavior-only config).
 */
export function parseLocalConfig(raw: unknown): ProjectShadow {
  if (!raw || typeof raw !== "object") {
    return {} as ProjectShadow;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!IDENTITY_FIELDS.has(key)) {
      result[key] = value;
    }
  }

  return result as ProjectShadow;
}
