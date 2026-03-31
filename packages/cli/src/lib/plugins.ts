import type { Agent, OrchestratorConfig } from "@composio/ao-core";
import claudeCodePlugin from "@composio/ao-plugin-agent-claude-code";
import codexPlugin from "@composio/ao-plugin-agent-codex";
import aiderPlugin from "@composio/ao-plugin-agent-aider";
import opencodePlugin from "@composio/ao-plugin-agent-opencode";

const agentPlugins: Record<string, { create(): Agent }> = {
  "claude-code": claudeCodePlugin,
  codex: codexPlugin,
  aider: aiderPlugin,
  opencode: opencodePlugin,
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
