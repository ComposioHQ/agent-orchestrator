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
  type OrchestratorConfig,
  type PluginRegistry,
  type SessionManager,
  type SCM,
  type ProjectConfig,
} from "@agent-orchestrator/core";

// Static plugin imports — webpack needs these to be string literals
import pluginRuntimeTmux from "@agent-orchestrator/plugin-runtime-tmux";
import pluginAgentClaudeCode from "@agent-orchestrator/plugin-agent-claude-code";
import pluginWorkspaceWorktree from "@agent-orchestrator/plugin-workspace-worktree";
import pluginScmGithub from "@agent-orchestrator/plugin-scm-github";
import pluginTrackerGithub from "@agent-orchestrator/plugin-tracker-github";

export interface Services {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
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

  const sessionManager = createSessionManager({ config, registry });

  const services = { config, registry, sessionManager };
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
