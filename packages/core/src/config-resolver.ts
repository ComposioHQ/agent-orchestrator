/**
 * Config resolver — builds OrchestratorConfig from global registry.
 *
 * Merges project registry entries with their shadow configs to produce
 * the same OrchestratorConfig shape that the rest of the system expects.
 */

import type { GlobalConfig, OrchestratorConfig } from "./types.js";
import { validateConfig } from "./config.js";

/**
 * Build an OrchestratorConfig from the global registry.
 * Merges each project's registry entry (identity) with its shadow (behavior).
 */
export function resolveMultiProjectConfig(
  global: GlobalConfig,
  globalConfigPath: string,
): OrchestratorConfig {
  const projects: Record<string, Record<string, unknown>> = {};

  for (const [projectId, entry] of Object.entries(global.projects)) {
    const shadow = global.shadows[projectId] ?? {};
    projects[projectId] = {
      name: entry.name,
      repo: entry.repo,
      path: entry.path,
      defaultBranch: entry.defaultBranch,
      ...(entry.sessionPrefix ? { sessionPrefix: entry.sessionPrefix } : {}),
      ...shadow,
    };
  }

  const raw: Record<string, unknown> = {
    projects,
  };

  // Transfer daemon-level settings
  if (global.daemon.port !== undefined) raw["port"] = global.daemon.port;
  if (global.daemon.terminalPort !== undefined) raw["terminalPort"] = global.daemon.terminalPort;
  if (global.daemon.directTerminalPort !== undefined)
    raw["directTerminalPort"] = global.daemon.directTerminalPort;
  if (global.daemon.readyThresholdMs !== undefined)
    raw["readyThresholdMs"] = global.daemon.readyThresholdMs;
  if (global.defaults) raw["defaults"] = global.defaults;
  if (global.notifiers) raw["notifiers"] = global.notifiers;
  if (global.notificationRouting) raw["notificationRouting"] = global.notificationRouting;
  if (global.reactions) raw["reactions"] = global.reactions;

  const config = validateConfig(raw);
  config.configPath = globalConfigPath;
  return config;
}
