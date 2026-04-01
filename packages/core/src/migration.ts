/**
 * Effective config builder for multi-project mode.
 *
 * Merges the global config registry (identity) with per-project shadow
 * files (behavior) to produce an OrchestratorConfig compatible with the
 * rest of the system.
 */

import type {
  OrchestratorConfig,
  ProjectConfig,
  TrackerConfig,
  SCMConfig,
  AgentSpecificConfig,
  RoleAgentConfig,
  ReactionConfig,
  DefaultPlugins,
  NotifierConfig,
  EventPriority,
} from "./types.js";
import {
  type GlobalConfig,
  loadShadowFile,
  detectConfigMode,
  findLocalConfigPath,
  loadLocalProjectConfig,
} from "./global-config.js";
import { expandHome } from "./paths.js";

/**
 * Build an OrchestratorConfig from global config + local/shadow configs.
 *
 * For each project in the global config:
 * - If local config exists at project.path (hybrid mode): use local config for behavior
 * - Otherwise (global-only mode): use shadow file at projects/{id}.yaml for behavior
 *
 * The result is an OrchestratorConfig that looks exactly like the old format
 * (with all projects populated), allowing existing code to work without changes.
 */
export function buildEffectiveConfig(
  globalConfig: GlobalConfig,
  globalConfigPath: string,
): OrchestratorConfig {
  const projects: Record<string, ProjectConfig> = {};

  for (const [projectId, entry] of Object.entries(globalConfig.projects)) {
    const projectPath = expandHome(entry.path);
    const mode = detectConfigMode(projectPath);

    let behaviorFields: Record<string, unknown>;

    if (mode === "hybrid") {
      const localPath = findLocalConfigPath(projectPath);
      if (localPath) {
        try {
          const localConfig = loadLocalProjectConfig(localPath);
          behaviorFields = localConfig as Record<string, unknown>;
        } catch {
          // Invalid local config — fall back to shadow file
          behaviorFields = loadShadowOrEmpty(projectId);
        }
      } else {
        behaviorFields = loadShadowOrEmpty(projectId);
      }
    } else {
      // Global-only mode: shadow file IS the config
      behaviorFields = loadShadowOrEmpty(projectId);
    }

    // The project ID (map key) is already the session prefix — do not
    // re-apply generateSessionPrefix, which would double-abbreviate it.
    const sessionPrefix = projectId;
    const repo = String(behaviorFields["repo"] ?? "");

    // Don't infer scm/tracker here — leave them for applyProjectDefaults
    // which has the full inferScmPlugin logic (GitLab detection, etc.).

    projects[projectId] = {
      name: entry.name ?? projectId,
      repo,
      path: projectPath,
      defaultBranch: String(behaviorFields["defaultBranch"] ?? "main"),
      sessionPrefix,
      configMode: mode,
      runtime: behaviorFields["runtime"] as string | undefined,
      agent: behaviorFields["agent"] as string | undefined,
      workspace: behaviorFields["workspace"] as string | undefined,
      tracker: behaviorFields["tracker"] as TrackerConfig | undefined,
      scm: behaviorFields["scm"] as SCMConfig | undefined,
      symlinks: behaviorFields["symlinks"] as string[] | undefined,
      postCreate: behaviorFields["postCreate"] as string[] | undefined,
      agentConfig: behaviorFields["agentConfig"] as AgentSpecificConfig | undefined,
      orchestrator: behaviorFields["orchestrator"] as RoleAgentConfig | undefined,
      worker: behaviorFields["worker"] as RoleAgentConfig | undefined,
      reactions: behaviorFields["reactions"] as Record<string, Partial<ReactionConfig>> | undefined,
      agentRules: behaviorFields["agentRules"] as string | undefined,
      agentRulesFile: behaviorFields["agentRulesFile"] as string | undefined,
      orchestratorRules: behaviorFields["orchestratorRules"] as string | undefined,
      orchestratorSessionStrategy: behaviorFields["orchestratorSessionStrategy"] as ProjectConfig["orchestratorSessionStrategy"],
      opencodeIssueSessionStrategy: behaviorFields["opencodeIssueSessionStrategy"] as ProjectConfig["opencodeIssueSessionStrategy"],
      decomposer: behaviorFields["decomposer"] as ProjectConfig["decomposer"],
    };
  }

  return {
    configPath: globalConfigPath,
    globalConfigPath,
    port: globalConfig.port,
    terminalPort: globalConfig.terminalPort,
    directTerminalPort: globalConfig.directTerminalPort,
    readyThresholdMs: globalConfig.readyThresholdMs,
    defaults: globalConfig.defaults as DefaultPlugins,
    projects,
    projectOrder: globalConfig.projectOrder,
    notifiers: globalConfig.notifiers as Record<string, NotifierConfig>,
    notificationRouting: globalConfig.notificationRouting as Record<EventPriority, string[]>,
    reactions: globalConfig.reactions as Record<string, ReactionConfig>,
    plugins: globalConfig.plugins as OrchestratorConfig["plugins"],
  };
}

/** Load shadow file for a project, stripping internal fields. Returns {} if missing. */
function loadShadowOrEmpty(projectId: string): Record<string, unknown> {
  const shadow = loadShadowFile(projectId);
  if (!shadow) return {};
  const behavior: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shadow)) {
    if (!key.startsWith("_")) {
      behavior[key] = value;
    }
  }
  return behavior;
}
