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
  EventPriority,
} from "./types.js";
import {
  type GlobalConfig,
  loadShadowFile,
  detectConfigMode,
  findLocalConfigPath,
  loadLocalProjectConfig,
} from "./global-config.js";
import { expandHome, generateSessionPrefix, generateProjectId } from "./paths.js";

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
  const mergedNotifiers: OrchestratorConfig["notifiers"] = {};
  const mergedRouting: Partial<Record<EventPriority, string[]>> = {};

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

    // Honor an explicit sessionPrefix from the behavior fields (e.g. set via
    // migration from an old config or a custom shadow file value). Fall back
    // to deriving the prefix from the project path — this is correct whether
    // projectId is the abbreviated form ("ao") or the full basename
    // ("agent-orchestrator") registered by newer versions.
    const sessionPrefix = (behaviorFields["sessionPrefix"] as string | undefined)
      ?? generateSessionPrefix(generateProjectId(projectPath));
    const repo = String(behaviorFields["repo"] ?? "");
    if (!repo) {
      console.warn(
        `[ao] Warning: project "${projectId}" has no "repo" field. ` +
        `SCM and tracker features will not be available until a repo URL is set.`,
      );
    }

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
      agentConfig: (behaviorFields["agentConfig"] as AgentSpecificConfig | undefined) ?? {} as AgentSpecificConfig,
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

    if (behaviorFields["notifiers"]) {
      const projectNotifiers = behaviorFields["notifiers"] as OrchestratorConfig["notifiers"];
      for (const [key, value] of Object.entries(projectNotifiers ?? {})) {
        if (key in mergedNotifiers) {
          // First-registered project wins. Overwriting would silently route
          // one project's alerts to a different project's destination.
          console.warn(
            `[ao] Warning: notifier key "${key}" is already defined — ` +
            `skipping duplicate from project "${projectId}". ` +
            `Use unique notifier keys per project to avoid conflicts.`,
          );
        } else {
          mergedNotifiers[key] = value;
        }
      }
    }
    if (behaviorFields["notificationRouting"]) {
      const routing = behaviorFields["notificationRouting"] as Partial<Record<EventPriority, string[]>>;
      for (const [priority, channels] of Object.entries(routing)) {
        if (priority in mergedRouting) {
          // First-registered project wins — consistent with notifier key deduplication.
          console.warn(
            `[ao] Warning: notificationRouting priority "${priority}" is already defined — ` +
            `skipping duplicate from project "${projectId}". ` +
            `Use unique routing configurations per project to avoid conflicts.`,
          );
        } else {
          mergedRouting[priority as EventPriority] = channels;
        }
      }
    }
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
    // These are global infrastructure settings (which channels exist, how
    // priorities route). Per-project reaction overrides are on ProjectConfig.
    notifiers: mergedNotifiers,
    notificationRouting: {
      urgent: ["desktop", "composio"],
      action: ["desktop", "composio"],
      warning: ["composio"],
      info: ["composio"],
      ...mergedRouting,
    } as Record<EventPriority, string[]>,
    reactions: {},
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
