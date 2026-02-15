/**
 * Server-side singleton for core services.
 *
 * Lazily initializes config, plugin registry, and session manager.
 * Cached in globalThis to survive Next.js HMR reloads in development.
 *
 * NOTE: Plugins are explicitly imported here because Next.js webpack
 * cannot resolve dynamic `import(variable)` expressions used by the
 * core plugin registry's loadBuiltins(). Static imports let webpack
 * bundle them correctly.
 */

import {
  loadConfig,
  createPluginRegistry,
  createSessionManager,
  createLifecycleManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type SessionManager,
  type LifecycleManager,
  type SCM,
  type Tracker,
  type ProjectConfig,
} from "@composio/ao-core";

// Notifier plugins
import pluginNotifierDesktop from "@composio/ao-plugin-notifier-desktop";
import pluginNotifierOpenclaw from "@composio/ao-plugin-notifier-openclaw";

// Static plugin imports — webpack needs these to be string literals
import pluginRuntimeTmux from "@composio/ao-plugin-runtime-tmux";
import pluginAgentClaudeCode from "@composio/ao-plugin-agent-claude-code";
import pluginWorkspaceWorktree from "@composio/ao-plugin-workspace-worktree";
import pluginScmGithub from "@composio/ao-plugin-scm-github";
import pluginTrackerGithub from "@composio/ao-plugin-tracker-github";
import pluginTrackerLinear from "@composio/ao-plugin-tracker-linear";

export interface Services {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
  lifecycleManager: LifecycleManager;
}

// Cache in globalThis for Next.js HMR stability
const globalForServices = globalThis as typeof globalThis & {
  _aoServices?: Services;
  _aoServicesInit?: Promise<Services>;
};

/** Get (or lazily initialize) the core services singleton. */
export function getServices(): Promise<Services> {
  if (globalForServices._aoServices) {
    return Promise.resolve(globalForServices._aoServices);
  }
  if (!globalForServices._aoServicesInit) {
    globalForServices._aoServicesInit = initServices().catch((err) => {
      // Clear the cached promise so the next call retries instead of
      // permanently returning a rejected promise.
      globalForServices._aoServicesInit = undefined;
      throw err;
    });
  }
  return globalForServices._aoServicesInit;
}

async function initServices(): Promise<Services> {
  const config = loadConfig();
  const registry = createPluginRegistry();

  // Register plugins explicitly (webpack can't handle dynamic import() in core)
  registry.register(pluginRuntimeTmux);
  registry.register(pluginAgentClaudeCode);
  registry.register(pluginWorkspaceWorktree);
  registry.register(pluginScmGithub);
  registry.register(pluginTrackerGithub);
  registry.register(pluginTrackerLinear);

  // Register notifier plugins (pass config from notifiers record)
  registry.register(pluginNotifierDesktop, config.notifiers?.["desktop"] as Record<string, unknown> | undefined);
  registry.register(pluginNotifierOpenclaw, config.notifiers?.["openclaw"] as Record<string, unknown> | undefined);

  const sessionManager = createSessionManager({ config, registry });

  // Create and start lifecycle manager (polling loop + notifiers)
  const lifecycleManager = createLifecycleManager({ config, registry, sessionManager });
  lifecycleManager.start(15_000); // Poll every 15 seconds

  // Graceful shutdown
  const shutdown = () => {
    lifecycleManager.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const services = { config, registry, sessionManager, lifecycleManager };
  globalForServices._aoServices = services;
  return services;
}

/** Resolve the SCM plugin for a project. Returns null if not configured. */
export function getSCM(
  registry: PluginRegistry,
  project: ProjectConfig | undefined,
): SCM | null {
  if (!project?.scm) return null;
  return registry.get<SCM>("scm", project.scm.plugin);
}

/** Resolve the Tracker plugin for a project. Returns null if not configured. */
export function getTracker(
  registry: PluginRegistry,
  project: ProjectConfig | undefined,
): Tracker | null {
  if (!project?.tracker) return null;
  return registry.get<Tracker>("tracker", project.tracker.plugin);
}
