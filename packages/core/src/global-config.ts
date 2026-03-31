/**
 * Global config management for multi-project architecture.
 *
 * Layout:
 *   ~/.agent-orchestrator/
 *     config.yaml              ← Lightweight registry: project identity + global settings
 *     projects/
 *       {id}.yaml              ← Per-project shadow: behavior fields only
 *
 * The global config at config.yaml owns:
 * - Project registry (identity: name, path, project ID)
 * - Global operational settings (port, defaults, notifiers, reactions)
 *
 * Shadow files at projects/{id}.yaml own:
 * - Project behavior (agent, runtime, tracker, reactions, etc.)
 * - Synced from local config on `ao start` (hybrid mode)
 * - Edited directly by user (global-only mode)
 *
 * Two ownership modes per project:
 * - Hybrid: local config exists → shadow is a read-only cache synced on `ao start`
 * - Global-only: no local config → shadow IS the authoritative config
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { expandHome } from "./paths.js";

// =============================================================================
// TYPES
// =============================================================================

/** Config ownership mode per project */
export type ConfigMode = "hybrid" | "global-only";

/** Identity fields that are never overwritten by shadow sync */
const IDENTITY_FIELDS = new Set(["name", "path"]);

/** Internal fields (prefixed with _) */
const isInternalField = (key: string): boolean => key.startsWith("_");

/** Secret-like field patterns (excluded from shadow sync in hybrid mode) */
const SECRET_PATTERNS = [/token$/i, /key$/i, /secret$/i, /password$/i];

export function isSecretField(key: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(key));
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

/**
 * Project entry in global config — identity only.
 * Behavior fields live in separate shadow files at ~/.agent-orchestrator/projects/{id}.yaml.
 */
const GlobalProjectEntrySchema = z.object({
  /** Display name */
  name: z.string().optional(),
  /** Local path to the repo */
  path: z.string(),
});

/**
 * Global config schema.
 * Contains project registry + operational settings.
 */
const GlobalConfigSchema = z.object({
  /** Web dashboard port */
  port: z.number().default(3000),
  /** Terminal WebSocket server port */
  terminalPort: z.number().optional(),
  /** Direct terminal WebSocket server port */
  directTerminalPort: z.number().optional(),
  /** Milliseconds before "ready" becomes "idle" */
  readyThresholdMs: z.number().nonnegative().default(300_000),
  /** Default plugin selections */
  defaults: z
    .object({
      runtime: z.string().default("tmux"),
      agent: z.string().default("claude-code"),
      workspace: z.string().default("worktree"),
      notifiers: z.array(z.string()).default(["composio", "desktop"]),
      orchestrator: z.object({ agent: z.string().optional() }).optional(),
      worker: z.object({ agent: z.string().optional() }).optional(),
    })
    .default({}),
  /** Project registry (identity only — behavior is in shadow files) */
  projects: z.record(GlobalProjectEntrySchema).default({}),
  /** Display order for projects in sidebar/portfolio */
  projectOrder: z.array(z.string()).optional(),
  /** Notification channel configs */
  notifiers: z
    .record(z.object({ plugin: z.string() }).passthrough())
    .default({}),
  /** Notification routing by priority */
  notificationRouting: z
    .record(z.array(z.string()))
    .default({
      urgent: ["desktop", "composio"],
      action: ["desktop", "composio"],
      warning: ["composio"],
      info: ["composio"],
    }),
  /** Default reaction configs */
  reactions: z.record(z.any()).default({}),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type GlobalProjectEntry = z.infer<typeof GlobalProjectEntrySchema>;

// =============================================================================
// LOCAL (FLAT) CONFIG SCHEMA
// =============================================================================

/**
 * New local project config — flat, behavior-only.
 * No `projects:` wrapper, no identity fields (name, path, sessionPrefix).
 */
const LocalProjectConfigSchema = z
  .object({
    repo: z.string(),
    defaultBranch: z.string().default("main"),
    runtime: z.string().optional(),
    agent: z.string().optional(),
    workspace: z.string().optional(),
    tracker: z.object({ plugin: z.string() }).passthrough().optional(),
    scm: z
      .object({
        plugin: z.string(),
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
      .optional(),
    symlinks: z.array(z.string()).optional(),
    postCreate: z.array(z.string()).optional(),
    agentConfig: z
      .object({
        permissions: z
          .enum(["permissionless", "default", "auto-edit", "suggest", "skip"])
          .default("permissionless")
          .transform((v) => (v === "skip" ? "permissionless" : v)),
        model: z.string().optional(),
        orchestratorModel: z.string().optional(),
        opencodeSessionId: z.string().optional(),
      })
      .passthrough()
      .default({}),
    orchestrator: z
      .object({
        agent: z.string().optional(),
        agentConfig: z
          .object({
            permissions: z
              .union([
                z.enum(["permissionless", "default", "auto-edit", "suggest"]),
                z.literal("skip"),
              ])
              .optional(),
            model: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .optional(),
    worker: z
      .object({
        agent: z.string().optional(),
        agentConfig: z
          .object({
            permissions: z
              .union([
                z.enum(["permissionless", "default", "auto-edit", "suggest"]),
                z.literal("skip"),
              ])
              .optional(),
            model: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .optional(),
    reactions: z.record(z.any()).optional(),
    notifiers: z.record(z.object({ plugin: z.string() }).passthrough()).optional(),
    notificationRouting: z.record(z.array(z.string())).optional(),
    agentRules: z.string().optional(),
    agentRulesFile: z.string().optional(),
    orchestratorRules: z.string().optional(),
    orchestratorSessionStrategy: z
      .enum(["reuse", "delete", "ignore", "delete-new", "ignore-new", "kill-previous"])
      .optional(),
    opencodeIssueSessionStrategy: z.enum(["reuse", "delete", "ignore"]).optional(),
    decomposer: z
      .object({
        enabled: z.boolean().default(false),
        maxDepth: z.number().min(1).max(5).default(3),
        model: z.string().default("claude-sonnet-4-20250514"),
        requireApproval: z.boolean().default(true),
      })
      .optional(),
  })
  .passthrough();

export type LocalProjectConfig = z.infer<typeof LocalProjectConfigSchema>;

// =============================================================================
// DISCOVERY
// =============================================================================

/**
 * Discover the global config file path.
 *
 * Discovery order:
 * 1. AO_GLOBAL_CONFIG_PATH env var (dedicated to global config — avoids
 *    collision with AO_CONFIG_PATH which points to local/legacy configs)
 * 2. $XDG_CONFIG_HOME/agent-orchestrator/config.yaml (if XDG_CONFIG_HOME set)
 * 3. ~/.agent-orchestrator/config.yaml (fallback)
 */
export function findGlobalConfigPath(): string {
  if (process.env["AO_GLOBAL_CONFIG_PATH"]) {
    return resolve(process.env["AO_GLOBAL_CONFIG_PATH"]);
  }

  if (process.env["XDG_CONFIG_HOME"]) {
    return resolve(process.env["XDG_CONFIG_HOME"], "agent-orchestrator", "config.yaml");
  }

  return resolve(homedir(), ".agent-orchestrator", "config.yaml");
}

/**
 * Get the global data directory path.
 *
 * Discovery order:
 * 1. $XDG_DATA_HOME/agent-orchestrator/ (if XDG_DATA_HOME set)
 * 2. ~/.local/share/agent-orchestrator/ (if XDG_CONFIG_HOME set but not XDG_DATA_HOME)
 * 3. ~/.agent-orchestrator/ (config and data colocated)
 */
export function getGlobalDataDir(): string {
  if (process.env["XDG_DATA_HOME"]) {
    return resolve(process.env["XDG_DATA_HOME"], "agent-orchestrator");
  }

  if (process.env["XDG_CONFIG_HOME"]) {
    return resolve(homedir(), ".local", "share", "agent-orchestrator");
  }

  return resolve(homedir(), ".agent-orchestrator");
}

// =============================================================================
// LOADING
// =============================================================================

/**
 * Check if a global config file exists.
 */
export function globalConfigExists(): boolean {
  return existsSync(findGlobalConfigPath());
}

/**
 * Load the global config. Returns null if not found.
 */
export function loadGlobalConfig(): GlobalConfig | null {
  const path = findGlobalConfigPath();
  if (!existsSync(path)) {
    return null;
  }

  // One-time migration: move inline shadows to per-project files.
  // Wrapped in try/catch so malformed YAML doesn't bypass the friendly
  // validation error below.
  try {
    migrateInlineShadowsToFiles();
  } catch {
    // Migration failed — continue to validation which will report the error
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);

  let validated: z.infer<typeof GlobalConfigSchema>;
  try {
    validated = GlobalConfigSchema.parse(parsed);
  } catch (err) {
    const detail = err instanceof z.ZodError
      ? err.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
      : String(err);
    throw new Error(`Invalid global config at ${path}:\n${detail}`, { cause: err });
  }

  // Clone before mutating to avoid modifying Zod's parse output directly
  const config = structuredClone(validated);
  for (const entry of Object.values(config.projects)) {
    entry.path = expandHome(entry.path);
  }

  return config;
}

/**
 * Load the global config, throwing if not found.
 */
export function loadGlobalConfigOrThrow(): GlobalConfig {
  const config = loadGlobalConfig();
  if (!config) {
    throw new Error(
      "No global config found. Run `ao start` in a project directory to set up.",
    );
  }
  return config;
}

// =============================================================================
// SAVING
// =============================================================================

/**
 * Write the global config atomically (write to temp, rename).
 */
export function saveGlobalConfig(config: GlobalConfig): void {
  const path = findGlobalConfigPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  // Contract paths back to ~ for readability
  const serializable = structuredClone(config);
  const home = homedir();
  for (const entry of Object.values(serializable.projects)) {
    if (entry.path.startsWith(home + "/")) {
      entry.path = "~/" + entry.path.slice(home.length + 1);
    }
  }

  const yaml = stringifyYaml(serializable, { lineWidth: 0 });
  // Write temp file in the same directory as the target to avoid EXDEV errors
  // when /tmp is on a different filesystem (common on Linux with tmpfs).
  const tmpPath = join(dir, `.config-${randomBytes(6).toString("hex")}.yaml.tmp`);
  writeFileSync(tmpPath, yaml, "utf-8");
  renameSync(tmpPath, path);
}

// =============================================================================
// SCAFFOLD
// =============================================================================

/**
 * Create a minimal global config with no projects registered.
 */
export function scaffoldGlobalConfig(): GlobalConfig {
  const config = GlobalConfigSchema.parse({});
  saveGlobalConfig(config);
  return config;
}

// =============================================================================
// PROJECT REGISTRATION
// =============================================================================

/**
 * Register a project in the global config.
 * Does not save — caller must call saveGlobalConfig().
 */
export function registerProject(
  globalConfig: GlobalConfig,
  projectId: string,
  entry: GlobalProjectEntry,
): GlobalConfig {
  const updated = structuredClone(globalConfig);
  updated.projects[projectId] = entry;
  return updated;
}

/**
 * Remove a project from the global config.
 * Does not save — caller must call saveGlobalConfig().
 */
export function unregisterProject(
  globalConfig: GlobalConfig,
  projectId: string,
): GlobalConfig {
  const updated = structuredClone(globalConfig);
  const { [projectId]: _, ...remainingProjects } = updated.projects;
  updated.projects = remainingProjects;
  if (updated.projectOrder) {
    updated.projectOrder = updated.projectOrder.filter((id) => id !== projectId);
  }
  // Clean up the per-project shadow file
  deleteShadowFile(projectId);
  return updated;
}

// =============================================================================
// SHADOW FILE I/O
// =============================================================================

/**
 * Get the directory where per-project shadow files are stored.
 * Located next to the global config file: ~/.agent-orchestrator/projects/
 */
export function getShadowDir(): string {
  const globalPath = findGlobalConfigPath();
  return join(dirname(globalPath), "projects");
}

/**
 * Get the shadow file path for a specific project.
 */
export function getShadowFilePath(projectId: string): string {
  return join(getShadowDir(), `${projectId}.yaml`);
}

/**
 * Load a shadow file for a project. Returns null if missing or unparseable.
 * Fault-isolated: one broken shadow does not affect other projects.
 */
export function loadShadowFile(projectId: string): Record<string, unknown> | null {
  const filePath = getShadowFilePath(projectId);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Save a shadow file for a project. Atomic write (temp + rename).
 */
export function saveShadowFile(projectId: string, data: Record<string, unknown>): void {
  const dir = getShadowDir();
  mkdirSync(dir, { recursive: true });
  const filePath = getShadowFilePath(projectId);
  const yaml = stringifyYaml(data, { lineWidth: 0 });
  const tmpPath = join(dir, `.${projectId}-${randomBytes(6).toString("hex")}.yaml.tmp`);
  writeFileSync(tmpPath, yaml, "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Delete a shadow file for a project.
 */
export function deleteShadowFile(projectId: string): void {
  const filePath = getShadowFilePath(projectId);
  if (!existsSync(filePath)) return;
  try {
    unlinkSync(filePath);
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Migrate inline shadow data from global config to per-project files.
 * Called on loadGlobalConfig when inline behavior fields are detected.
 * This is a one-time transparent migration from the old inline format.
 */
export function migrateInlineShadowsToFiles(): boolean {
  const path = findGlobalConfigPath();
  if (!existsSync(path)) return false;

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as Record<string, unknown>;
  const projects = parsed["projects"] as Record<string, Record<string, unknown>> | undefined;
  if (!projects) return false;

  const identityKeys = new Set(["name", "path"]);
  let migrated = false;

  for (const [id, entry] of Object.entries(projects)) {
    if (typeof entry !== "object" || entry === null) continue;

    // Check if this entry has any non-identity keys (behavior fields)
    const behaviorKeys = Object.keys(entry).filter((k) => !identityKeys.has(k));
    if (behaviorKeys.length === 0) continue;

    // Don't overwrite an existing shadow file
    if (existsSync(getShadowFilePath(id))) continue;

    // Extract behavior fields into a shadow file
    const shadow: Record<string, unknown> = {};
    for (const key of behaviorKeys) {
      shadow[key] = entry[key];
    }
    saveShadowFile(id, shadow);

    // Strip behavior fields from inline entry (mutating parsed object)
    for (const key of behaviorKeys) {
      delete entry[key]; // eslint-disable-line @typescript-eslint/no-dynamic-delete
    }
    migrated = true;
  }

  if (migrated) {
    // Rewrite config.yaml with identity-only entries
    const yaml = stringifyYaml(parsed, { lineWidth: 0 });
    const dir = dirname(path);
    const tmpPath = join(dir, `.config-${randomBytes(6).toString("hex")}.yaml.tmp`);
    writeFileSync(tmpPath, yaml, "utf-8");
    renameSync(tmpPath, path);
  }

  return migrated;
}

// =============================================================================
// MODE DETECTION
// =============================================================================

/**
 * Detect the config ownership mode for a project.
 *
 * - If a local `agent-orchestrator.yaml` exists at project.path → hybrid
 * - Otherwise → global-only
 */
export function detectConfigMode(projectPath: string): ConfigMode {
  const localPath = findLocalConfigPath(projectPath);
  return localPath ? "hybrid" : "global-only";
}

/**
 * Find the local config file for a project, if it exists.
 */
export function findLocalConfigPath(projectPath: string): string | null {
  const expanded = expandHome(projectPath);
  const candidates = [
    join(expanded, "agent-orchestrator.yaml"),
    join(expanded, "agent-orchestrator.yml"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Load a flat local project config from a file path.
 */
export function loadLocalProjectConfig(configPath: string): LocalProjectConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  return LocalProjectConfigSchema.parse(parsed);
}

// =============================================================================
// SHADOW SYNC
// =============================================================================

/**
 * Sync local config into a per-project shadow file (hybrid mode).
 *
 * Writes behavior fields to ~/.agent-orchestrator/projects/{id}.yaml.
 * Does NOT modify the global config (identity stays in config.yaml).
 * Excludes secret-like fields with a warning.
 *
 * Returns { unchanged global config, excluded secret fields }
 */
export function syncShadow(
  globalConfig: GlobalConfig,
  projectId: string,
  localConfig: LocalProjectConfig,
): { config: GlobalConfig; excludedSecrets: string[] } {
  if (!globalConfig.projects[projectId]) {
    throw new Error(`Project "${projectId}" not found in global config`);
  }

  // Build shadow from local config, excluding identity and secrets
  const excludedSecrets: string[] = [];
  const shadow: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(localConfig)) {
    if (IDENTITY_FIELDS.has(key) || isInternalField(key)) continue;

    if (isSecretField(key)) {
      excludedSecrets.push(key);
      continue;
    }

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      shadow[key] = filterSecrets(value as Record<string, unknown>, excludedSecrets, key);
    } else {
      shadow[key] = value;
    }
  }

  shadow["_shadowSyncedAt"] = Math.floor(Date.now() / 1000);

  // Write to per-project shadow file (not inline in global config)
  saveShadowFile(projectId, shadow);

  // Return globalConfig unchanged — identity stays in config.yaml
  return { config: globalConfig, excludedSecrets };
}

/** Recursively filter secret-like fields from an object at all nesting levels */
export function filterSecrets(
  obj: Record<string, unknown>,
  excluded: string[],
  parentKey: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSecretField(key)) {
      excluded.push(`${parentKey}.${key}`);
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = filterSecrets(value as Record<string, unknown>, excluded, `${parentKey}.${key}`);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// =============================================================================
// EFFECTIVE CONFIG RESOLUTION
// =============================================================================

/**
 * Detect if raw YAML content is the old single-project format.
 * Old format: `projects:` key with entries containing both identity (path)
 * and behavior fields (repo) inline. New format: identity-only entries
 * (behavior is in separate shadow files).
 */
export function isOldConfigFormat(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;

  if (!obj["projects"] || typeof obj["projects"] !== "object") return false;

  const projects = obj["projects"] as Record<string, unknown>;
  for (const entry of Object.values(projects)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    // Old format has `repo` inline (behavior mixed with identity)
    if ("path" in e && "repo" in e) {
      return true;
    }
  }
  return false;
}

/**
 * Check if raw YAML content is the new flat local config format.
 * Flat format has `repo` at the top level, no `projects:` wrapper.
 */
export function isFlatLocalConfig(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return "repo" in obj && !("projects" in obj);
}

/**
 * Match the current working directory to a registered project.
 * Returns the project ID if found, null otherwise.
 */
export function matchProjectByCwd(
  globalConfig: GlobalConfig,
  cwd: string,
): string | null {
  const resolvedCwd = resolve(cwd);
  let bestMatch: { id: string; pathLen: number } | null = null;
  for (const [id, entry] of Object.entries(globalConfig.projects)) {
    const resolvedPath = resolve(expandHome(entry.path));
    if (resolvedCwd === resolvedPath || resolvedCwd.startsWith(resolvedPath + sep)) {
      // Prefer the longest (most specific) matching path
      if (!bestMatch || resolvedPath.length > bestMatch.pathLen) {
        bestMatch = { id, pathLen: resolvedPath.length };
      }
    }
  }
  return bestMatch?.id ?? null;
}

/**
 * Check if a project path is already registered (under a different ID).
 */
export function findProjectByPath(
  globalConfig: GlobalConfig,
  projectPath: string,
): { id: string; entry: GlobalProjectEntry } | null {
  const resolvedPath = resolve(expandHome(projectPath));
  for (const [id, entry] of Object.entries(globalConfig.projects)) {
    if (resolve(expandHome(entry.path)) === resolvedPath) {
      return { id, entry };
    }
  }
  return null;
}
