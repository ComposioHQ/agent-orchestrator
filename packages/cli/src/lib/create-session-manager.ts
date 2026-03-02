/**
 * Session manager factory for the CLI.
 *
 * Creates a PluginRegistry with all available plugins loaded,
 * then creates a SessionManager instance backed by core's implementation.
 * This ensures the CLI uses the same hash-based naming, metadata format,
 * and plugin abstractions as the rest of the system.
 */

import {
  createPluginRegistry,
  createSessionManager,
  type OrchestratorConfig,
  type SessionManager,
  type PluginRegistry,
} from "@composio/ao-core";

let registryPromise: Promise<PluginRegistry> | null = null;

/**
 * Get or create the plugin registry.
 * Caches the Promise (not the resolved value) so concurrent callers
 * await the same initialization rather than racing.
 */
async function getRegistry(config: OrchestratorConfig): Promise<PluginRegistry> {
  if (!registryPromise) {
    registryPromise = (async () => {
      const registry = createPluginRegistry();
      // Pass CLI's import context so pnpm strict resolution can find plugin packages.
      // Core can't resolve @composio/ao-plugin-* from its own module context because
      // they aren't in core's dependencies. The CLI has them as workspace deps.
      await registry.loadFromConfig(config, (pkg: string) => import(pkg));
      return registry;
    })();
  }
  return registryPromise;
}

export async function getPluginRegistry(config: OrchestratorConfig): Promise<PluginRegistry> {
  return getRegistry(config);
}

/**
 * Create a SessionManager backed by core's implementation.
 * Initializes the plugin registry from config and wires everything up.
 */
export async function getSessionManager(config: OrchestratorConfig): Promise<SessionManager> {
  const registry = await getRegistry(config);
  return createSessionManager({ config, registry });
}
