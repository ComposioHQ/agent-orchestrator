import type { Agent, OrchestratorConfig, SCM } from "@composio/ao-core";
import { createPluginRegistry } from "@composio/ao-core";
import claudeCodePlugin from "@composio/ao-plugin-agent-claude-code";
import codexPlugin from "@composio/ao-plugin-agent-codex";
import aiderPlugin from "@composio/ao-plugin-agent-aider";
import opencodePlugin from "@composio/ao-plugin-agent-opencode";
import githubSCMPlugin from "@composio/ao-plugin-scm-github";
import gitlabSCMPlugin from "@composio/ao-plugin-scm-gitlab";

const agentPlugins: Record<string, { create(): Agent }> = {
  "claude-code": claudeCodePlugin,
  codex: codexPlugin,
  aider: aiderPlugin,
  opencode: opencodePlugin,
};

const builtinSCMPlugins: Record<string, { create(): SCM }> = {
  github: githubSCMPlugin,
  gitlab: gitlabSCMPlugin,
};

/**
 * Resolve the Agent plugin for a project (or fall back to the config default).
 * Direct import — no dynamic loading needed since the CLI depends on all agent plugins.
 */
export function getAgent(config: OrchestratorConfig, projectId?: string): Agent {
  const agentName =
    (projectId ? config.projects[projectId]?.agent : undefined) || config.defaults.agent;
  const plugin = agentPlugins[agentName];
  if (!plugin) {
    throw new Error(`Unknown agent plugin: ${agentName}`);
  }
  return plugin.create();
}

/** Get an agent by name directly (for fallback/no-config scenarios). */
export function getAgentByName(name: string): Agent {
  const plugin = agentPlugins[name];
  if (!plugin) {
    throw new Error(`Unknown agent plugin: ${name}`);
  }
  return plugin.create();
}

/**
 * Resolve the SCM plugin for a project (or fall back to "github").
 * First checks built-in plugins, then loads external plugins from config.
 */
export async function getSCM(config: OrchestratorConfig, projectId: string): Promise<SCM> {
  const scmName = config.projects[projectId]?.scm?.plugin || "github";
  const scmConfig = config.projects[projectId]?.scm as Record<string, unknown> | undefined;

  // Try built-in first
  const builtin = builtinSCMPlugins[scmName];
  if (builtin) {
    return builtin.create();
  }

  // Fall back to plugin-registry (loads external plugins from config.plugins[])
  const registry = createPluginRegistry();
  await registry.loadFromConfig(config, (pkg: string) => import(pkg));
  const scm = registry.get<SCM>("scm", scmName);
  if (!scm) {
    throw new Error(`Unknown SCM plugin: ${scmName}`);
  }
  return scm;
}
