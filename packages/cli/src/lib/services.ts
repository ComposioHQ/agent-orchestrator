/**
 * Service initialization for CLI.
 *
 * Lazily initializes config, plugin registry, and session manager.
 */

import {
  loadConfig,
  createPluginRegistry,
  createSessionManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type SessionManager,
} from "@composio/ao-core";

export interface Services {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

let cachedServices: Services | undefined;

/** Get (or lazily initialize) the core services. */
export async function getServices(): Promise<Services> {
  if (cachedServices) {
    return cachedServices;
  }

  const config = loadConfig();
  const registry = createPluginRegistry();

  // Load built-in plugins
  await registry.loadBuiltins(config);

  const sessionManager = createSessionManager({ config, registry });

  cachedServices = { config, registry, sessionManager };
  return cachedServices;
}
