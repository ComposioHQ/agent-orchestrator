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
import { expandHome } from "./paths.js";

// ---------------------------------------------------------------------------
// Type-safe behavior field helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : undefined;
}

function asObject<T>(v: unknown): T | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as T)
    : undefined;
}

/**
 * Build an OrchestratorConfig from global config + local/shadow configs.
 *
 * For each project in the global config:
 * - If local config exists at project.path (hybrid mode): use local config for behavior
 * - Otherwise (global-only mode): use shadow file at projects/{id}.yaml for behavior
 *
 * The result is an OrchestratorConfig that looks exactly like the old format
 * (with all projects populated), allowing existing code to work without changes.
 *
 * @param warnings Optional array that receives warning messages (e.g. silent
 *   fallbacks from broken local configs). Callers that surface messages to the
 *   user should pass this in.
 */
export function buildEffectiveConfig(
  globalConfig: GlobalConfig,
  globalConfigPath: string,
  warnings?: string[],
): OrchestratorConfig {
  const projects: Record<string, ProjectConfig> = {};
  const mergedNotifiers: OrchestratorConfig["notifiers"] = {};
  const mergedRouting: Partial<Record<EventPriority, string[]>> = {};

  for (const [projectId, entry] of Object.entries(globalConfig.projects)) {
    // Expand for internal use (detectConfigMode, findLocalConfigPath need an absolute path).
    // The project stores the raw entry.path so expandPaths in applyGlobalConfigPipeline
    // performs the single canonical expansion — avoiding double-expansion.
    const expandedPath = expandHome(entry.path);
    const mode = detectConfigMode(expandedPath);

    let behaviorFields: Record<string, unknown>;

    if (mode === "hybrid") {
      const localPath = findLocalConfigPath(expandedPath);
      if (localPath) {
        try {
          const localConfig = loadLocalProjectConfig(localPath);
          behaviorFields = localConfig as Record<string, unknown>;
        } catch (err) {
          // Invalid local config — fall back to shadow file and warn the caller
          // so the user knows their local config is NOT being applied.
          warnings?.push(
            `Project "${projectId}": local config at ${localPath} is invalid ` +
              `(${err instanceof Error ? err.message : String(err)}); ` +
              `using shadow file instead. Fix the local config and re-run \`ao start\`.`,
          );
          behaviorFields = loadShadowOrEmpty(projectId);
        }
      } else {
        behaviorFields = loadShadowOrEmpty(projectId);
      }
    } else {
      // Global-only mode: shadow file IS the config
      behaviorFields = loadShadowOrEmpty(projectId);
    }

    // Use the explicit sessionPrefix from the behavior/shadow fields if present.
    // Leave it empty otherwise — applyProjectDefaults (via applyGlobalConfigPipeline)
    // is the single source of truth for deriving the prefix from the project path.
    const sessionPrefix = asString(behaviorFields["sessionPrefix"]) ?? "";
    const repo = String(behaviorFields["repo"] ?? "");

    // Don't infer scm/tracker here — leave them for applyProjectDefaults
    // which has the full inferScmPlugin logic (GitLab detection, etc.).

    projects[projectId] = {
      name: entry.name ?? projectId,
      repo,
      path: entry.path,
      defaultBranch: String(behaviorFields["defaultBranch"] ?? "main"),
      sessionPrefix,
      configMode: mode,
      runtime: asString(behaviorFields["runtime"]),
      agent: asString(behaviorFields["agent"]),
      workspace: asString(behaviorFields["workspace"]),
      tracker: asObject<TrackerConfig>(behaviorFields["tracker"]),
      scm: asObject<SCMConfig>(behaviorFields["scm"]),
      symlinks: asStringArray(behaviorFields["symlinks"]),
      postCreate: asStringArray(behaviorFields["postCreate"]),
      agentConfig: asObject<AgentSpecificConfig>(behaviorFields["agentConfig"]) ?? ({} as AgentSpecificConfig),
      orchestrator: asObject<RoleAgentConfig>(behaviorFields["orchestrator"]),
      worker: asObject<RoleAgentConfig>(behaviorFields["worker"]),
      reactions: asObject<Record<string, Partial<ReactionConfig>>>(behaviorFields["reactions"]),
      agentRules: asString(behaviorFields["agentRules"]),
      agentRulesFile: asString(behaviorFields["agentRulesFile"]),
      orchestratorRules: asString(behaviorFields["orchestratorRules"]),
      orchestratorSessionStrategy: asString(behaviorFields["orchestratorSessionStrategy"]) as ProjectConfig["orchestratorSessionStrategy"],
      opencodeIssueSessionStrategy: asString(behaviorFields["opencodeIssueSessionStrategy"]) as ProjectConfig["opencodeIssueSessionStrategy"],
      decomposer: asObject<ProjectConfig["decomposer"]>(behaviorFields["decomposer"]),
    };

    if (behaviorFields["notifiers"]) {
      Object.assign(mergedNotifiers, asObject<OrchestratorConfig["notifiers"]>(behaviorFields["notifiers"]) ?? {});
    }
    if (behaviorFields["notificationRouting"]) {
      Object.assign(mergedRouting, asObject<Record<string, string[]>>(behaviorFields["notificationRouting"]) ?? {});
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
