/**
 * Configuration loader — reads agent-orchestrator.yaml and validates with Zod.
 *
 * Minimal config that just works:
 *   projects:
 *     my-app:
 *       repo: org/repo
 *       path: ~/my-app
 *
 * Everything else has sensible defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigNotFoundError, type ExternalPluginEntryRef, type OrchestratorConfig } from "./types.js";
import { generateSessionPrefix } from "./paths.js";
import { PromptLoader } from "./prompts/loader.js";

function inferScmPlugin(project: {
  repo: string;
  scm?: Record<string, unknown>;
  tracker?: Record<string, unknown>;
}): "github" | "gitlab" {
  const scmPlugin = project.scm?.["plugin"];
  if (scmPlugin === "gitlab") {
    return "gitlab";
  }

  const scmHost = project.scm?.["host"];
  if (typeof scmHost === "string" && scmHost.toLowerCase().includes("gitlab")) {
    return "gitlab";
  }

  const trackerPlugin = project.tracker?.["plugin"];
  if (trackerPlugin === "gitlab") {
    return "gitlab";
  }

  const trackerHost = project.tracker?.["host"];
  if (typeof trackerHost === "string" && trackerHost.toLowerCase().includes("gitlab")) {
    return "gitlab";
  }

  return "github";
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

/**
 * Common validation for plugin config fields (tracker, scm, notifier).
 * Must have either plugin (for built-ins) or package/path (for external plugins).
 * Cannot have both package and path.
 */
function validatePluginConfigFields(
  value: { plugin?: string; package?: string; path?: string },
  ctx: z.RefinementCtx,
  configType: string,
): void {
  // Must have either plugin or package/path
  if (!value.plugin && !value.package && !value.path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${configType} config requires either 'plugin' (for built-ins) or 'package'/'path' (for external plugins)`,
    });
  }
  // Cannot have both package and path
  if (value.package && value.path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${configType} config cannot have both 'package' and 'path' - use one or the other`,
    });
  }
}

const ReactionConfigSchema = z.object({
  auto: z.boolean().default(true),
  action: z.enum(["send-to-agent", "notify", "auto-merge"]).default("notify"),
  message: z.string().optional(),
  priority: z.enum(["urgent", "action", "warning", "info"]).optional(),
  retries: z.number().optional(),
  escalateAfter: z.union([z.number(), z.string()]).optional(),
  threshold: z.string().optional(),
  includeSummary: z.boolean().optional(),
});

const TrackerConfigSchema = z
  .object({
    plugin: z.string().optional(),
    package: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => validatePluginConfigFields(value, ctx, "Tracker"));

const SCMConfigSchema = z
  .object({
    plugin: z.string().optional(),
    package: z.string().optional(),
    path: z.string().optional(),
    webhook: z
      .object({
        enabled: z.boolean().default(true),
        path: z.string().optional(),
        secretEnvVar: z.string().optional(),
        signatureHeader: z.string().optional(),
        eventHeader: z.string().optional(),
        deliveryHeader: z.string().optional(),
        maxBodyBytes: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => validatePluginConfigFields(value, ctx, "SCM"));

const NotifierConfigSchema = z
  .object({
    plugin: z.string().optional(),
    package: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => validatePluginConfigFields(value, ctx, "Notifier"));

const AgentPermissionSchema = z
  .enum(["permissionless", "default", "auto-edit", "suggest", "skip"])
  .default("permissionless")
  .transform((value) => (value === "skip" ? "permissionless" : value));

const AgentSpecificConfigSchema = z
  .object({
    permissions: AgentPermissionSchema,
    model: z.string().optional(),
    orchestratorModel: z.string().optional(),
    opencodeSessionId: z.string().optional(),
  })
  .passthrough();

const RoleAgentSpecificConfigSchema = z
  .object({
    permissions: z
      .union([z.enum(["permissionless", "default", "auto-edit", "suggest"]), z.literal("skip")])
      .optional(),
    model: z.string().optional(),
    orchestratorModel: z.string().optional(),
    opencodeSessionId: z.string().optional(),
  })
  .passthrough();

const RoleAgentDefaultsSchema = z
  .object({
    agent: z.string().optional(),
  })
  .optional();

const RoleAgentConfigSchema = z
  .object({
    agent: z.string().optional(),
    agentConfig: RoleAgentSpecificConfigSchema.optional(),
  })
  .optional();

const AdversarialCriticConfigSchema = z.object({
  agent: z.string(),
  agentConfig: AgentSpecificConfigSchema.optional(),
});

const AdversarialPhaseConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxRounds: z.number().int().min(1).default(2),
});

const AdversarialCodePhaseConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxRounds: z.number().int().min(1).default(1),
});

const AdversarialReviewConfigSchema = z.object({
  enabled: z.boolean().default(false),
  critic: AdversarialCriticConfigSchema,
  plan: AdversarialPhaseConfigSchema.optional(),
  code: AdversarialCodePhaseConfigSchema.optional(),
});

/** @internal — exported for testing only */
export { AdversarialReviewConfigSchema as _AdversarialReviewConfigSchema };

const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  repo: z.string(),
  path: z.string(),
  defaultBranch: z.string().default("main"),
  sessionPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "sessionPrefix must match [a-zA-Z0-9_-]+")
    .optional(),
  runtime: z.string().optional(),
  agent: z.string().optional(),
  workspace: z.string().optional(),
  tracker: TrackerConfigSchema.optional(),
  scm: SCMConfigSchema.optional(),
  symlinks: z.array(z.string()).optional(),
  postCreate: z.array(z.string()).optional(),
  agentConfig: AgentSpecificConfigSchema.default({}),
  orchestrator: RoleAgentConfigSchema,
  worker: RoleAgentConfigSchema,
  reactions: z.record(ReactionConfigSchema.partial()).optional(),
  agentRules: z.string().optional(),
  agentRulesFile: z.string().optional(),
  orchestratorRules: z.string().optional(),
  orchestratorSessionStrategy: z
    .enum(["reuse", "delete", "ignore", "delete-new", "ignore-new", "kill-previous"])
    .optional(),
  opencodeIssueSessionStrategy: z.enum(["reuse", "delete", "ignore"]).optional(),
  adversarialReview: AdversarialReviewConfigSchema.optional(),
});

const DefaultPluginsSchema = z.object({
  runtime: z.string().default("tmux"),
  agent: z.string().default("claude-code"),
  workspace: z.string().default("worktree"),
  notifiers: z.array(z.string()).default([]),
  orchestrator: RoleAgentDefaultsSchema,
  worker: RoleAgentDefaultsSchema,
});

const InstalledPluginConfigSchema = z
  .object({
    name: z.string(),
    source: z.enum(["registry", "npm", "local"]),
    package: z.string().optional(),
    version: z.string().optional(),
    path: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.source === "local" && !value.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: "Local plugins require a path",
      });
    }

    if ((value.source === "registry" || value.source === "npm") && !value.package) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["package"],
        message: "Registry and npm plugins require a package name",
      });
    }
  });

const OrchestratorConfigSchema = z.object({
  port: z.number().default(3000),
  terminalPort: z.number().optional(),
  directTerminalPort: z.number().optional(),
  readyThresholdMs: z.number().nonnegative().default(300_000),
  promptsDir: z.string().optional(),
  defaults: DefaultPluginsSchema.default({}),
  plugins: z.array(InstalledPluginConfigSchema).default([]),
  projects: z.record(
    z.string().regex(/^[a-zA-Z0-9_-]+$/, "Project ID must match [a-zA-Z0-9_-]+ (no dots, slashes, or special characters)"),
    ProjectConfigSchema,
  ),
  notifiers: z.record(NotifierConfigSchema).default({}),
  notificationRouting: z.record(z.array(z.string())).default({}),
  reactions: z.record(ReactionConfigSchema).default({}),
});

// =============================================================================
// CONFIG LOADING
// =============================================================================

/** Expand ~ to home directory */
function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

/** Expand all path fields in the config */
function expandPaths(config: OrchestratorConfig): OrchestratorConfig {
  for (const project of Object.values(config.projects)) {
    project.path = expandHome(project.path);
  }

  for (const plugin of config.plugins ?? []) {
    if (plugin.path) {
      plugin.path = expandHome(plugin.path);
    }
  }

  return config;
}

/**
 * Generate a temporary plugin name from a package or path specifier.
 * This name is used until the actual manifest.name is discovered during plugin loading.
 * Format: extract the plugin name from the package/path, removing common prefixes.
 * e.g., "@acme/ao-plugin-tracker-jira" -> "jira"
 * e.g., "@acme/ao-plugin-tracker-jira-cloud" -> "jira-cloud"
 * e.g., "./plugins/my-tracker" -> "my-tracker"
 * e.g., "my-tracker" (local path without slashes) -> "my-tracker"
 */
function generateTempPluginName(pkg?: string, path?: string): string {
  if (pkg) {
    // Extract package name without scope: "@acme/ao-plugin-tracker-jira" -> "ao-plugin-tracker-jira"
    const slashParts = pkg.split("/");
    const packageName = slashParts[slashParts.length - 1] ?? pkg;

    // Extract plugin name after ao-plugin-{slot}- prefix, preserving multi-word names like "jira-cloud"
    const prefixMatch = packageName.match(/^ao-plugin-(?:runtime|agent|workspace|tracker|scm|notifier|terminal)-(.+)$/);
    if (prefixMatch?.[1]) {
      return prefixMatch[1];
    }

    // Non-standard package name (doesn't follow ao-plugin convention): use the full package name
    // to avoid collisions. "plugin" from "custom-tracker-plugin" would collide with other packages
    // that also end in "-plugin". The temp name is replaced with manifest.name after loading anyway.
    return packageName;
  }

  // Handle local paths: use the basename
  // ./plugins/my-tracker -> my-tracker
  // my-tracker -> my-tracker (no slashes is still a valid path)
  if (path) {
    const segments = path.split("/").filter((s) => s && s !== "." && s !== "..");
    return segments[segments.length - 1] ?? path;
  }

  return "unknown";
}

/**
 * Helper to process a single external plugin config entry.
 * Expands home paths, generates temp plugin name if needed, and returns the entry ref.
 */
function processExternalPluginConfig(
  pluginConfig: { plugin?: string; package?: string; path?: string },
  source: string,
  location: ExternalPluginEntryRef["location"],
  slot: ExternalPluginEntryRef["slot"],
): ExternalPluginEntryRef | null {
  if (!pluginConfig.package && !pluginConfig.path) return null;

  // Expand home paths (~/...) for consistency with config.plugins
  if (pluginConfig.path) {
    pluginConfig.path = expandHome(pluginConfig.path);
  }

  // Track if user explicitly specified plugin name (for validation)
  const userSpecifiedPlugin = pluginConfig.plugin;

  // If plugin name not specified, generate a temporary one from package/path
  if (!pluginConfig.plugin) {
    pluginConfig.plugin = generateTempPluginName(pluginConfig.package, pluginConfig.path);
  }

  return {
    source,
    location,
    slot,
    package: pluginConfig.package,
    path: pluginConfig.path,
    expectedPluginName: userSpecifiedPlugin,
  };
}

/**
 * Collect external plugin configs from tracker, scm, and notifier inline configs.
 * These will be auto-added to config.plugins for loading.
 *
 * Also sets a temporary plugin name on configs that only have package/path,
 * so that resolvePlugins() can look up the plugin by name.
 *
 * IMPORTANT: Only sets expectedPluginName when user explicitly specified `plugin`.
 * When plugin is auto-generated, expectedPluginName is left undefined so that
 * any manifest.name is accepted and the config is updated with it.
 */
export function collectExternalPluginConfigs(config: OrchestratorConfig): ExternalPluginEntryRef[] {
  const entries: ExternalPluginEntryRef[] = [];

  // Collect from project tracker and scm configs
  for (const [projectId, project] of Object.entries(config.projects)) {
    if (project.tracker) {
      const entry = processExternalPluginConfig(
        project.tracker,
        `projects.${projectId}.tracker`,
        { kind: "project", projectId, configType: "tracker" },
        "tracker",
      );
      if (entry) entries.push(entry);
    }

    if (project.scm) {
      const entry = processExternalPluginConfig(
        project.scm,
        `projects.${projectId}.scm`,
        { kind: "project", projectId, configType: "scm" },
        "scm",
      );
      if (entry) entries.push(entry);
    }
  }

  // Collect from global notifier configs
  for (const [notifierId, notifierConfig] of Object.entries(config.notifiers ?? {})) {
    if (notifierConfig) {
      const entry = processExternalPluginConfig(
        notifierConfig,
        `notifiers.${notifierId}`,
        { kind: "notifier", notifierId },
        "notifier",
      );
      if (entry) entries.push(entry);
    }
  }

  return entries;
}

/**
 * Generate InstalledPluginConfig entries from external plugin entries.
 * Merges with existing plugins, avoiding duplicates by package/path.
 */
function mergeExternalPlugins(
  existingPlugins: OrchestratorConfig["plugins"],
  externalEntries: ExternalPluginEntryRef[],
): OrchestratorConfig["plugins"] {
  const plugins = [...(existingPlugins ?? [])];
  const seen = new Set<string>();

  // Track existing plugins by package/path
  for (const plugin of plugins) {
    if (plugin.package) seen.add(`package:${plugin.package}`);
    if (plugin.path) seen.add(`path:${plugin.path}`);
  }

  // Add external entries that aren't already present, or enable if disabled
  for (const entry of externalEntries) {
    const key = entry.package ? `package:${entry.package}` : `path:${entry.path}`;
    if (seen.has(key)) {
      // If the existing plugin is disabled but there's an inline reference, enable it
      const existingPlugin = plugins.find(
        (p) =>
          (entry.package && p.package === entry.package) ||
          (entry.path && p.path === entry.path),
      );
      if (existingPlugin && existingPlugin.enabled === false) {
        existingPlugin.enabled = true;
      }
      continue;
    }
    seen.add(key);

    // Generate a temporary name - will be replaced with manifest.name during loading
    const tempName = entry.expectedPluginName ?? generateTempPluginName(entry.package, entry.path);

    plugins.push({
      name: tempName,
      source: entry.package ? "npm" : "local",
      package: entry.package,
      path: entry.path,
      enabled: true,
    });
  }

  return plugins;
}

/** Apply defaults to project configs */
function applyProjectDefaults(config: OrchestratorConfig): OrchestratorConfig {
  for (const [id, project] of Object.entries(config.projects)) {
    // Derive name from project ID if not set
    if (!project.name) {
      project.name = id;
    }

    // Derive session prefix from project path basename if not set
    if (!project.sessionPrefix) {
      const projectId = basename(project.path);
      project.sessionPrefix = generateSessionPrefix(projectId);
    }

    const inferredPlugin = inferScmPlugin(project);

    // Infer SCM from repo if not set
    if (!project.scm && project.repo.includes("/")) {
      project.scm = { plugin: inferredPlugin };
    }

    // Infer tracker from repo if not set (default to github issues)
    if (!project.tracker) {
      project.tracker = { plugin: inferredPlugin };
    }
  }

  return config;
}

/** Validate project uniqueness and session prefix collisions */
function validateProjectUniqueness(config: OrchestratorConfig): void {
  // Check for duplicate project IDs (basenames) across different paths.
  // Multiple config entries sharing the same path is valid (multi-orchestrator),
  // but different paths that resolve to the same basename would collide in storage.
  const projectIdToPaths: Record<string, Set<string>> = {};

  for (const [_configKey, project] of Object.entries(config.projects)) {
    const projectId = basename(project.path);

    if (!projectIdToPaths[projectId]) {
      projectIdToPaths[projectId] = new Set();
    }
    projectIdToPaths[projectId].add(project.path);

    if (projectIdToPaths[projectId].size > 1) {
      const paths = [...projectIdToPaths[projectId]].join(", ");
      throw new Error(
        `Duplicate project ID detected: "${projectId}"\n` +
          `Multiple projects have the same directory basename but different paths:\n` +
          `  ${paths}\n\n` +
          `To fix this, ensure each project path has a unique directory name.\n` +
          `Alternatively, you can use the config key as a unique identifier.`,
      );
    }
  }

  // Check for duplicate session prefixes
  const prefixes = new Set<string>();
  const prefixToProject: Record<string, string> = {};

  for (const [configKey, project] of Object.entries(config.projects)) {
    const projectId = basename(project.path);
    const prefix = project.sessionPrefix || generateSessionPrefix(projectId);

    if (prefixes.has(prefix)) {
      const firstProjectKey = prefixToProject[prefix];
      const firstProject = config.projects[firstProjectKey];
      throw new Error(
        `Duplicate session prefix detected: "${prefix}"\n` +
          `Projects "${firstProjectKey}" and "${configKey}" would generate the same prefix.\n\n` +
          `To fix this, add an explicit sessionPrefix to one of these projects:\n\n` +
          `projects:\n` +
          `  ${firstProjectKey}:\n` +
          `    path: ${firstProject?.path}\n` +
          `    sessionPrefix: ${prefix}1  # Add explicit prefix\n` +
          `  ${configKey}:\n` +
          `    path: ${project.path}\n` +
          `    sessionPrefix: ${prefix}2  # Add explicit prefix\n`,
      );
    }

    prefixes.add(prefix);
    prefixToProject[prefix] = configKey;
  }
}

/** Apply default reactions */
function applyDefaultReactions(
  config: OrchestratorConfig,
  promptLoader: PromptLoader,
): OrchestratorConfig {
  const defaults: Record<string, (typeof config.reactions)[string]> = {
    "ci-failed": {
      auto: true,
      action: "send-to-agent",
      message: promptLoader.renderReaction("ci-failed"),
      retries: 2,
      escalateAfter: 2,
    },
    "changes-requested": {
      auto: true,
      action: "send-to-agent",
      message: promptLoader.renderReaction("changes-requested"),
      escalateAfter: "30m",
    },
    "bugbot-comments": {
      auto: true,
      action: "send-to-agent",
      message: promptLoader.renderReaction("bugbot-comments"),
      escalateAfter: "30m",
    },
    "merge-conflicts": {
      auto: true,
      action: "send-to-agent",
      message: promptLoader.renderReaction("merge-conflicts"),
      escalateAfter: "15m",
    },
    "approved-and-green": {
      auto: false,
      action: "notify",
      priority: "action",
      message: promptLoader.renderReaction("approved-and-green"),
    },
    "agent-idle": {
      auto: true,
      action: "send-to-agent",
      message: promptLoader.renderReaction("agent-idle"),
      retries: 2,
      escalateAfter: "15m",
    },
    "agent-stuck": {
      auto: true,
      action: "notify",
      priority: "urgent",
      threshold: "10m",
    },
    "agent-needs-input": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "agent-exited": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "all-complete": {
      auto: true,
      action: "notify",
      priority: "info",
      includeSummary: true,
    },
  };

  // Merge defaults with user-specified reactions (user wins)
  config.reactions = { ...defaults, ...config.reactions };

  return config;
}

/**
 * Search for config file in standard locations.
 *
 * Search order:
 * 1. AO_CONFIG_PATH environment variable (if set)
 * 2. Search up directory tree from CWD (like git)
 * 3. Explicit startDir (if provided)
 * 4. Home directory locations
 */
export function findConfigFile(startDir?: string): string | null {
  // 1. Check environment variable override
  if (process.env["AO_CONFIG_PATH"]) {
    const envPath = resolve(process.env["AO_CONFIG_PATH"]);
    if (existsSync(envPath)) {
      return envPath;
    }
  }

  // 2. Search up directory tree from CWD (like git)
  const searchUpTree = (dir: string): string | null => {
    const configFiles = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];

    for (const filename of configFiles) {
      const configPath = resolve(dir, filename);
      if (existsSync(configPath)) {
        return configPath;
      }
    }

    const parent = resolve(dir, "..");
    if (parent === dir) {
      // Reached root
      return null;
    }

    return searchUpTree(parent);
  };

  const cwd = process.cwd();
  const foundInTree = searchUpTree(cwd);
  if (foundInTree) {
    return foundInTree;
  }

  // 3. Check explicit startDir if provided
  if (startDir) {
    const files = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];
    for (const filename of files) {
      const path = resolve(startDir, filename);
      if (existsSync(path)) {
        return path;
      }
    }
  }

  // 4. Check home directory locations
  const homePaths = [
    resolve(homedir(), ".agent-orchestrator.yaml"),
    resolve(homedir(), ".agent-orchestrator.yml"),
    resolve(homedir(), ".config", "agent-orchestrator", "config.yaml"),
  ];

  for (const path of homePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Find config file path (exported for use in hash generation) */
export function findConfig(startDir?: string): string | null {
  return findConfigFile(startDir);
}

/** Load and validate config from a YAML file */
export function loadConfig(configPath?: string): OrchestratorConfig {
  // Priority: 1. Explicit param, 2. Search (including AO_CONFIG_PATH env var)
  // findConfigFile handles AO_CONFIG_PATH validation, so delegate to it
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new ConfigNotFoundError();
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed, { configPath: path });

  // Set the config path in the config object for hash generation
  config.configPath = path;

  return config;
}

/** Load config and return both config and resolved path */
export function loadConfigWithPath(configPath?: string): {
  config: OrchestratorConfig;
  path: string;
} {
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new ConfigNotFoundError();
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed, { configPath: path });

  // Set the config path in the config object for hash generation
  config.configPath = path;

  return { config, path };
}

/** Validate a raw config object */
export function validateConfig(
  raw: unknown,
  options?: { configPath?: string },
): OrchestratorConfig {
  const validated = OrchestratorConfigSchema.parse(raw);

  let config = validated as OrchestratorConfig;
  config = expandPaths(config);
  config = applyProjectDefaults(config);
  const configRoot =
    options?.configPath
      ? dirname(resolve(options.configPath))
      : Object.values(config.projects)[0]?.path ?? process.cwd();
  const promptLoader = new PromptLoader({
    projectDir: configRoot,
    promptsDir: config.promptsDir,
  });
  config = applyDefaultReactions(config, promptLoader);

  // Collect external plugin configs from inline tracker/scm/notifier configs
  // and merge them into config.plugins for loading
  const externalPluginEntries = collectExternalPluginConfigs(config);
  if (externalPluginEntries.length > 0) {
    config.plugins = mergeExternalPlugins(config.plugins, externalPluginEntries);
    // Store entries for manifest validation during plugin loading
    config._externalPluginEntries = externalPluginEntries;
  }

  // Validate project uniqueness and prefix collisions
  validateProjectUniqueness(config);

  return config;
}

/** Get the default config (useful for `ao init`) */
export function getDefaultConfig(): OrchestratorConfig {
  return validateConfig({
    projects: {},
  });
}
