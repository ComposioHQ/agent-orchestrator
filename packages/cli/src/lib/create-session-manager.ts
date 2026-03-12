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
  createLifecycleManager,
  type OrchestratorConfig,
  type OpenCodeSessionManager,
  type PluginRegistry,
  type LifecycleManager,
} from "@composio/ao-core";

let registryPromise: Promise<PluginRegistry> | null = null;

/**
 * Get or create the plugin registry.
 * Caches the Promise (not the resolved value) so concurrent callers
 * await the same initialization rather than racing.
 */
export async function getRegistry(config: OrchestratorConfig): Promise<PluginRegistry> {
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

/**
 * Create a SessionManager backed by core's implementation.
 * Initializes the plugin registry from config and wires everything up.
 */
export async function getSessionManager(
  config: OrchestratorConfig,
): Promise<OpenCodeSessionManager> {
  const registry = await getRegistry(config);
  return createSessionManager({ config, registry });
}

/**
 * Create a LifecycleManager backed by core's implementation.
 * Shares the same plugin registry initialization path as SessionManager.
 */
export async function getLifecycleManager(
  config: OrchestratorConfig,
  projectId?: string,
): Promise<LifecycleManager> {
  const registry = await getRegistry(config);
  const sessionManager = createSessionManager({ config, registry });
  return createLifecycleManager({ config, registry, sessionManager, projectId });
}
