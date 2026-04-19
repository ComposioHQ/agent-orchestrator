/**
 * Global config — the fixed-location registry + shadow copies.
 *
 * Option C (Hybrid Local + Shadow) architecture:
 *
 *   Global config  (~/.agent-orchestrator/config.yaml, XDG-aware)
 *     - Project registry: identity fields (name, path) per project
 *     - Shadow copies: behavior fields synced from local on `ao start`
 *     - Global operational settings: port, defaults, notifiers, reactions
 *
 *   Local config  (<project>/agent-orchestrator.yaml)
 *     - Behavior fields only (repo, agent, runtime, workspace, tracker, …)
 *     - No identity fields (name, path, sessionPrefix)
 *     - Flat YAML — no `projects:` wrapper
 *     - Source of truth; shadow is a convenience copy for remote/Docker use
 *
 * Load modes:
 *   In-project:  global (identity) + local (behavior) → merged effective config
 *   Remote:      global shadow only (no local config access needed)
 *   ao start:    validate local → sync shadow atomically → start daemon
 *
 * Sync rules:
 *   - Shadow updated ONLY on `ao start`
 *   - Fields matching *Token/*Key/*Secret/*Password excluded with warning
 *   - Identity fields (name, path) never overwritten by shadow sync
 *   - Unknown / future fields preserved as opaque passthrough
 *   - Write is always atomic (temp-file + rename)
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { atomicWriteFileSync } from "./atomic-write.js";
import { withFileLockSync } from "./file-lock.js";
import {
  generateSessionPrefix,
  getAoBaseDir,
  getProjectBaseDir,
  getSessionsDir,
} from "./paths.js";
import { deriveStorageKey, normalizeOriginUrl } from "./storage-key.js";

function globalConfigLockPath(configPath: string): string {
  return `${configPath}.lock`;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Identity fields owned by the global registry — never overwritten by shadow. */
const IDENTITY_FIELDS = new Set(["name", "path", "sessionPrefix", "storageKey", "originUrl"]);

/** Internal fields prefixed with underscore (e.g. _shadowSyncedAt). */
const INTERNAL_FIELD_PREFIX = "_";

/** Fields excluded from shadow sync (secret hygiene). Case-insensitive suffix match. */
const SECRET_SUFFIX_PATTERN = /(token|key|secret|password)$/i;

export class StorageKeyCollisionError extends Error {
  constructor(
    readonly storageKey: string,
    readonly existingProjectId: string,
    readonly projectId: string,
  ) {
    super(
      `Project "${existingProjectId}" already owns storage key "${storageKey}". ` +
        `Refusing to register "${projectId}" against the same repo slice without confirmation.`,
    );
    this.name = "StorageKeyCollisionError";
  }
}

export interface RegisterProjectOptions {
  allowStorageKeyReuse?: boolean;
}

export interface RelinkProjectOptions {
  url?: string;
  force?: boolean;
}

// =============================================================================
// GLOBAL CONFIG PATH (XDG-aware)
// =============================================================================

/**
 * Return the canonical path to the global config file.
 *
 * Priority:
 *   1. AO_GLOBAL_CONFIG environment variable (explicit global config override)
 *   2. $XDG_CONFIG_HOME/agent-orchestrator/config.yaml
 *   3. ~/.agent-orchestrator/config.yaml  (default)
 *
 * NOTE: This intentionally does NOT read AO_CONFIG_PATH. That env var is used
 * by findConfigFile() to locate any config (including project-local ones).
 * Using it here would risk overwriting a project-local config with global-format
 * YAML when syncProjectShadow/registerProjectInGlobalConfig call this function.
 */
export function getGlobalConfigPath(): string {
  if (process.env["AO_GLOBAL_CONFIG"]) {
    return resolve(process.env["AO_GLOBAL_CONFIG"]);
  }

  const xdgConfigHome = process.env["XDG_CONFIG_HOME"];
  if (xdgConfigHome) {
    return join(xdgConfigHome, "agent-orchestrator", "config.yaml");
  }

  return join(homedir(), ".agent-orchestrator", "config.yaml");
}

// =============================================================================
// GLOBAL CONFIG SCHEMA
// =============================================================================

/**
 * Per-project entry in the global registry.
 * Contains identity fields + shadow behavior fields (passthrough).
 * Internal _shadowSyncedAt tracks last successful sync timestamp.
 */
export const GlobalProjectEntrySchema = z
  .object({
    /** Display name (identity — never overwritten by shadow sync). */
    name: z.string().optional(),
    /** Absolute path to the project root (identity). */
    path: z.string(),
    /** Persisted storage hash — assigned once at registration, never recomputed. */
    storageKey: z.string().optional(),
    /** Canonical git origin URL used to derive the storage key. */
    originUrl: z.string().optional(),
    /** Unix timestamp of last successful shadow sync from local config. */
    _shadowSyncedAt: z.number().optional(),
  })
  .passthrough();

export type GlobalProjectEntry = z.infer<typeof GlobalProjectEntrySchema>;

/**
 * Global config schema.
 * Operational settings + project registry with shadow behavior fields.
 */
export const GlobalConfigSchema = z
  .object({
    /** Web dashboard port. Default: 3000 */
    port: z.number().default(3000),
    terminalPort: z.number().optional(),
    directTerminalPort: z.number().optional(),
    /** Time before a "ready" session becomes "idle". Default: 300 000 ms (5 min). */
    readyThresholdMs: z.number().nonnegative().default(300_000),
    /** Cross-project defaults — projects inherit when fields are omitted. */
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
    /** Project registry — map key is the canonical project ID. */
    projects: z.record(GlobalProjectEntrySchema).default({}),
    /** Optional explicit project ordering for sidebar / portfolio display. */
    projectOrder: z.array(z.string()).optional(),
    /** Notification channel configurations. */
    notifiers: z.record(z.object({ plugin: z.string() }).passthrough()).default({}),
    /** Maps priority levels to notifier channel IDs. */
    notificationRouting: z.record(z.array(z.string())).default({
      urgent: ["desktop", "composio"],
      action: ["desktop", "composio"],
      warning: ["composio"],
      info: ["composio"],
    }),
    /** Reaction rules (default reactions merged at load time). */
    reactions: z.record(z.object({}).passthrough()).default({}),
  })
  .passthrough();

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// =============================================================================
// LOCAL PROJECT CONFIG SCHEMA (flat, behavior-only)
// =============================================================================

/**
 * Flat, behavior-only local project config.
 * Lives at <project>/agent-orchestrator.yaml.
 *
 * Does NOT contain identity fields: name, path, sessionPrefix.
 * Those are owned by the global registry.
 *
 * Uses passthrough() for forward compatibility — unknown fields from
 * future ao versions are stored in the shadow without re-parsing.
 */
export const LocalProjectConfigSchema = z
  .object({
    repo: z.string().optional(),
    defaultBranch: z.string().optional(),
    runtime: z.string().optional(),
    agent: z.string().optional(),
    workspace: z.string().optional(),
    tracker: z.object({ plugin: z.string() }).passthrough().optional(),
    scm: z
      .object({
        plugin: z.string(),
        webhook: z
          .object({
            enabled: z.boolean().optional(),
            path: z.string().optional(),
            secretEnvVar: z.string().optional(),
            signatureHeader: z.string().optional(),
            eventHeader: z.string().optional(),
            deliveryHeader: z.string().optional(),
            maxBodyBytes: z.number().optional(),
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
          .optional(),
        model: z.string().optional(),
        orchestratorModel: z.string().optional(),
      })
      .passthrough()
      .optional(),
    orchestrator: z
      .object({ agent: z.string().optional(), agentConfig: z.object({}).passthrough().optional() })
      .optional(),
    worker: z
      .object({ agent: z.string().optional(), agentConfig: z.object({}).passthrough().optional() })
      .optional(),
    reactions: z.record(z.object({}).passthrough()).optional(),
    agentRules: z.string().optional(),
    agentRulesFile: z.string().optional(),
    orchestratorRules: z.string().optional(),
    orchestratorSessionStrategy: z
      .enum(["reuse", "delete", "ignore", "delete-new", "ignore-new", "kill-previous"])
      .optional(),
    opencodeIssueSessionStrategy: z.enum(["reuse", "delete", "ignore"]).optional(),
    decomposer: z.object({}).passthrough().optional(),
  })
  .passthrough();

export type LocalProjectConfig = z.infer<typeof LocalProjectConfigSchema>;

export interface LocalProjectConfigLoadResult {
  kind: "loaded" | "missing" | "old-format" | "malformed" | "invalid";
  config?: LocalProjectConfig;
  error?: string;
}

// =============================================================================
// LOAD / SAVE
// =============================================================================

/**
 * Load and validate the global config.
 * Returns null if the file does not exist (not an error — first run).
 */
export function loadGlobalConfig(configPath?: string): GlobalConfig | null {
  const path = configPath ?? getGlobalConfigPath();
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const config = GlobalConfigSchema.parse(parsed);

  // Expand ~ in project paths
  for (const entry of Object.values(config.projects)) {
    if (typeof entry.path === "string" && entry.path.startsWith("~/")) {
      entry.path = join(homedir(), entry.path.slice(2));
    }
  }

  return config;
}

/**
 * Save the global config atomically (temp-file + rename).
 * Creates parent directories if they don't exist.
 */
export function saveGlobalConfig(config: GlobalConfig, configPath?: string): void {
  const path = configPath ?? getGlobalConfigPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path, stringifyYaml(config, { indent: 2 }));
}

/**
 * Load a flat local project config from <projectPath>/agent-orchestrator.yaml.
 *
 * Returns null when:
 *   - No config file found at projectPath
 *   - File has a `projects:` wrapper (old format — use loadConfig() instead)
 *   - File is empty or malformed
 */
export function loadLocalProjectConfig(projectPath: string): LocalProjectConfig | null {
  const result = loadLocalProjectConfigDetailed(projectPath);
  return result.kind === "loaded" ? result.config ?? null : null;
}

export function loadLocalProjectConfigDetailed(projectPath: string): LocalProjectConfigLoadResult {
  const candidates = [
    join(projectPath, "agent-orchestrator.yaml"),
    join(projectPath, "agent-orchestrator.yml"),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;

    let parsed: unknown;
    try {
      const raw = readFileSync(path, "utf-8");
      parsed = parseYaml(raw);
    } catch (error) {
      return {
        kind: "malformed",
        error: `Failed to parse local config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!parsed || typeof parsed !== "object") {
      return {
        kind: "invalid",
        error: `Local config at ${path} must parse to an object`,
      };
    }

    // Old format: has `projects:` wrapper → not a flat local config
    if ("projects" in (parsed as Record<string, unknown>)) {
      return {
        kind: "old-format",
        error: `Local config at ${path} still uses a wrapped projects: format`,
      };
    }

    try {
      return {
        kind: "loaded",
        config: LocalProjectConfigSchema.parse(parsed),
      };
    } catch (error) {
      return {
        kind: "invalid",
        error: `Local config at ${path} failed validation: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return { kind: "missing" };
}

interface StorageIdentity {
  gitRoot: string;
  originUrl: string | null;
  storageKey: string;
}

function legacyProjectHash(projectPath: string): string {
  return createHash("sha256").update(resolve(projectPath)).digest("hex").slice(0, 12);
}

function resolveGitRoot(projectPath: string): string {
  let current = resolve(projectPath);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(projectPath);
    current = parent;
  }
}

function resolveGitConfigPath(gitRoot: string): string | null {
  const dotGitPath = join(gitRoot, ".git");
  if (!existsSync(dotGitPath)) return null;

  if (statSync(dotGitPath).isDirectory()) {
    const configPath = join(dotGitPath, "config");
    return existsSync(configPath) ? configPath : null;
  }

  const pointer = readFileSync(dotGitPath, "utf-8").trim();
  const match = pointer.match(/^gitdir:\s*(.+)$/i);
  if (!match) return null;

  const gitDir = resolve(gitRoot, match[1]);
  const directConfig = join(gitDir, "config");
  if (existsSync(directConfig)) return directConfig;

  const commonDirPath = join(gitDir, "commondir");
  if (!existsSync(commonDirPath)) return null;

  const commonDir = resolve(gitDir, readFileSync(commonDirPath, "utf-8").trim());
  const commonConfig = join(commonDir, "config");
  return existsSync(commonConfig) ? commonConfig : null;
}

function readOriginUrlFromGitConfig(projectPath: string): string | null {
  const gitRoot = resolveGitRoot(projectPath);
  const configPath = resolveGitConfigPath(gitRoot);
  if (!configPath) return null;

  const lines = readFileSync(configPath, "utf-8").split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[(.+)\]\s*$/);
    if (section) {
      inOrigin = section[1] === 'remote "origin"';
      continue;
    }
    if (!inOrigin) continue;

    const url = line.match(/^\s*url\s*=\s*(.+)\s*$/);
    if (url?.[1]) return url[1].trim();
  }

  return null;
}

function deriveProjectStorageIdentity(projectPath: string, originUrlOverride?: string | null): StorageIdentity {
  const gitRoot = resolveGitRoot(projectPath);
  const rawOriginUrl = originUrlOverride !== undefined ? originUrlOverride : readOriginUrlFromGitConfig(projectPath);
  const originUrl = rawOriginUrl === null ? null : normalizeOriginUrl(rawOriginUrl);
  return {
    gitRoot,
    originUrl,
    storageKey: deriveStorageKey({ originUrl, gitRoot, projectPath }),
  };
}

function findStorageKeyOwner(
  globalConfig: GlobalConfig,
  storageKey: string,
  excludeProjectId?: string,
): string | null {
  for (const [projectId, entry] of Object.entries(globalConfig.projects)) {
    if (projectId === excludeProjectId) continue;
    if (entry.storageKey === storageKey) return projectId;
  }
  return null;
}

function getLegacyProjectBaseDir(storageKey: string, projectPath: string): string {
  return join(getAoBaseDir(), `${storageKey}-${basename(projectPath)}`);
}

function moveStorageDirectory(fromDir: string, toDir: string): void {
  if (!existsSync(fromDir) || fromDir === toDir) return;
  if (existsSync(toDir)) {
    throw new Error(`Cannot move storage directory to ${toDir}: destination already exists`);
  }
  mkdirSync(dirname(toDir), { recursive: true });
  renameSync(fromDir, toDir);
}

function countSessionEntries(storageKey: string): number {
  const sessionsDir = getSessionsDir(storageKey);
  if (!existsSync(sessionsDir)) return 0;
  return readdirSync(sessionsDir).filter((entry) => entry !== ".DS_Store").length;
}

function ensureProjectStorageIdentity(
  projectId: string,
  globalConfig: GlobalConfig,
  globalConfigPath?: string,
  alreadyLocked = false,
): (GlobalProjectEntry & Record<string, unknown>) | null {
  const entry = globalConfig.projects[projectId] as (GlobalProjectEntry & Record<string, unknown>) | undefined;
  if (!entry?.path) return null;

  if (typeof entry.storageKey === "string" && typeof entry.originUrl === "string") {
    return entry;
  }

  const projectPath = entry.path;
  const oldStorageKey = typeof entry.storageKey === "string" ? entry.storageKey : legacyProjectHash(projectPath);
  const identity = deriveProjectStorageIdentity(projectPath);
  const nextStorageKey = identity.storageKey;
  const owner = findStorageKeyOwner(globalConfig, nextStorageKey, projectId);
  if (owner) {
    throw new StorageKeyCollisionError(nextStorageKey, owner, projectId);
  }

  const configPath = globalConfigPath ?? getGlobalConfigPath();
  const migrate = () => {
    const fresh = loadGlobalConfig(configPath) ?? globalConfig;
    const freshEntry = fresh.projects[projectId] as (GlobalProjectEntry & Record<string, unknown>) | undefined;
    if (!freshEntry?.path) return;

    const freshOldStorageKey =
      typeof freshEntry.storageKey === "string" ? freshEntry.storageKey : legacyProjectHash(freshEntry.path);
    const freshIdentity = deriveProjectStorageIdentity(
      freshEntry.path,
      typeof freshEntry.originUrl === "string" ? freshEntry.originUrl : undefined,
    );

    const collisionOwner = findStorageKeyOwner(fresh, freshIdentity.storageKey, projectId);
    if (collisionOwner) {
      throw new StorageKeyCollisionError(freshIdentity.storageKey, collisionOwner, projectId);
    }

    const targetDir = getProjectBaseDir(freshIdentity.storageKey);
    const legacyDir = getLegacyProjectBaseDir(freshOldStorageKey, freshEntry.path);
    const currentDir = getProjectBaseDir(freshOldStorageKey);

    if (freshOldStorageKey !== freshIdentity.storageKey) {
      if (existsSync(currentDir)) {
        moveStorageDirectory(currentDir, targetDir);
      } else if (existsSync(legacyDir)) {
        moveStorageDirectory(legacyDir, targetDir);
      }
    } else if (existsSync(legacyDir) && legacyDir !== targetDir && !existsSync(targetDir)) {
      moveStorageDirectory(legacyDir, targetDir);
    }

    freshEntry.storageKey = freshIdentity.storageKey;
    freshEntry.originUrl = freshIdentity.originUrl ?? `local://${resolve(freshIdentity.gitRoot)}`;
    saveGlobalConfig(fresh, configPath);

    entry.storageKey = freshEntry.storageKey;
    entry.originUrl = freshEntry.originUrl;
    console.info(
      `[ao] migrated storage identity for "${projectId}" to "${freshEntry.storageKey}" (${freshEntry.originUrl})`,
    );
  };

  if (alreadyLocked) {
    migrate();
  } else {
    withFileLockSync(globalConfigLockPath(configPath), migrate);
  }

  return entry;
}

// =============================================================================
// SHADOW SYNC
// =============================================================================

/**
 * Sync local project behavior fields into the global config shadow, atomically.
 *
 * Called by `ao start` after validating local config.
 *
 * Rules:
 *   - Identity fields (name, path, sessionPrefix, storageKey) are never overwritten
 *   - Fields starting with `_` (internal) are excluded
 *   - Fields matching *Token/*Key/*Secret/*Password are excluded (warn)
 *   - All other fields from localConfig are written verbatim (passthrough)
 *   - _shadowSyncedAt is set to current Unix timestamp
 *   - Write is atomic
 */
export function syncProjectShadow(
  projectId: string,
  localConfig: LocalProjectConfig,
  globalConfigPath?: string,
): void {
  const configPath = globalConfigPath ?? getGlobalConfigPath();
  withFileLockSync(globalConfigLockPath(configPath), () => {
  const globalConfig = loadGlobalConfig(configPath) ?? makeEmptyGlobalConfig();

  const existing = globalConfig.projects[projectId] as
    | (GlobalProjectEntry & Record<string, unknown>)
    | undefined;

  if (!existing || !existing.path) {
    throw new Error(
      `syncProjectShadow: project "${projectId}" is not registered in the global config. ` +
        `Call registerProjectInGlobalConfig() first.`,
    );
  }

  // Build shadow from local config fields
  const shadowFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(localConfig as Record<string, unknown>)) {
    if (IDENTITY_FIELDS.has(key)) continue;
    if (key.startsWith(INTERNAL_FIELD_PREFIX)) continue;
    if (SECRET_SUFFIX_PATTERN.test(key)) {
      process.stderr.write(
        `ao: warning — excluding "${key}" from shadow sync (secret-like field name). ` +
          `Use environment variables for secrets.\n`,
      );
      continue;
    }
    shadowFields[key] = value;
  }

  // Rebuild project entry: preserve identity, overwrite behavior
  globalConfig.projects[projectId] = {
    ...(existing.name !== null && existing.name !== undefined ? { name: existing.name } : {}),
    path: existing.path,
    ...(typeof existing.sessionPrefix === "string"
      ? { sessionPrefix: existing.sessionPrefix }
      : {}),
    ...(typeof existing.storageKey === "string"
      ? { storageKey: existing.storageKey }
      : {}),
    ...(typeof existing.originUrl === "string"
      ? { originUrl: existing.originUrl }
      : {}),
    ...shadowFields,
    _shadowSyncedAt: Math.floor(Date.now() / 1000),
  };

  saveGlobalConfig(globalConfig, configPath);
  });
}

// =============================================================================
// REGISTRATION
// =============================================================================

/**
 * Register or update a project in the global registry.
 *
 * - If the project already exists, identity fields are preserved and only
 *   updated if explicitly provided.
 * - If localConfig is provided, the shadow is synced immediately after
 *   writing the registry entry.
 * - Write is atomic.
 */
export function registerProjectInGlobalConfig(
  projectId: string,
  name: string,
  projectPath: string,
  localConfig?: LocalProjectConfig,
  optionsOrGlobalConfigPath?: RegisterProjectOptions | string,
  globalConfigPath?: string,
): void {
  const options = typeof optionsOrGlobalConfigPath === "string" ? {} : (optionsOrGlobalConfigPath ?? {});
  const configPath =
    typeof optionsOrGlobalConfigPath === "string"
      ? optionsOrGlobalConfigPath
      : (globalConfigPath ?? getGlobalConfigPath());
  const identity = deriveProjectStorageIdentity(projectPath);

  withFileLockSync(globalConfigLockPath(configPath), () => {
    const globalConfig = loadGlobalConfig(configPath) ?? makeEmptyGlobalConfig();

    const existing = globalConfig.projects[projectId] as
      | (GlobalProjectEntry & Record<string, unknown>)
      | undefined;

    if (existing?.path && resolve(existing.path) !== resolve(projectPath)) {
      throw new Error(
        `Project id "${projectId}" is already registered for "${existing.path}". ` +
          `Choose a different configProjectKey to add "${projectPath}" as a separate project.`,
      );
    }

    for (const [existingProjectId, entry] of Object.entries(globalConfig.projects)) {
      if (existingProjectId === projectId) continue;
      if (entry.path === projectPath) {
        throw new Error(
          `Project path "${projectPath}" is already registered as "${existingProjectId}"`,
        );
      }
    }

    const storageKey = (existing?.storageKey as string | undefined) ?? identity.storageKey;
    const collisionOwner = findStorageKeyOwner(globalConfig, storageKey, projectId);
    if (collisionOwner && !options.allowStorageKeyReuse) {
      throw new StorageKeyCollisionError(storageKey, collisionOwner, projectId);
    }

    globalConfig.projects[projectId] = {
      ...(existing ?? {}),
      name,
      path: projectPath,
      storageKey,
      originUrl:
        (existing?.originUrl as string | undefined) ??
        (identity.originUrl ?? `local://${resolve(identity.gitRoot)}`),
    };

    saveGlobalConfig(globalConfig, configPath);
  });

  if (localConfig) {
    syncProjectShadow(projectId, localConfig, configPath);
  }
}

// =============================================================================
// EFFECTIVE CONFIG BUILD
// =============================================================================

/**
 * Build effective project configuration by merging global registry identity
 * with local behavior config.
 *
 * Load order:
 *   1. Global entry supplies identity (name, path) + shadow behavior
 *   2. Local flat config (if present) overrides shadow behavior with fresh fields
 *   3. Shadow-fallback mode: global shadow used when local config is absent
 *
 * Returns a plain object compatible with ProjectConfig from config.ts.
 * Returns null if the project is not registered in the global config.
 */
export function buildEffectiveProjectConfig(
  projectId: string,
  globalConfig: GlobalConfig,
  globalConfigPath?: string,
): (Record<string, unknown> & { name: string; path: string; storageKey: string }) | null {
  const resolved = resolveProjectIdentity(projectId, globalConfig, globalConfigPath);
  return resolved ?? null;
}

/**
 * Resolve a single project from the canonical global registry.
 *
 * Behavior precedence:
 *   1. Identity always comes from the global registry entry
 *   2. Local flat config overrides shadow behavior when it loads cleanly
 *   3. Shadow behavior is used when local config is missing or broken
 *   4. When local config is broken, resolveError is attached instead of throwing
 */
export function resolveProjectIdentity(
  projectId: string,
  globalConfig: GlobalConfig,
  globalConfigPath?: string,
): (Record<string, unknown> & {
  name: string;
  path: string;
  storageKey: string;
  defaultBranch: string;
  sessionPrefix: string;
  resolveError?: string;
}) | null {
  const entry = globalConfig.projects[projectId] as
    | (GlobalProjectEntry & Record<string, unknown>)
    | undefined;
  if (!entry || !entry.path) return null;

  const ensuredEntry = ensureProjectStorageIdentity(projectId, globalConfig, globalConfigPath);
  if (!ensuredEntry) return null;

  const projectPath = ensuredEntry.path as string;
  const name = (ensuredEntry.name as string | undefined) ?? projectId;
  const storageKey = ensuredEntry.storageKey as string;

  const localConfigResult = loadLocalProjectConfigDetailed(projectPath);
  const { name: _name, path: _path, storageKey: _sk, originUrl: _originUrl, _shadowSyncedAt: _ts, ...shadowBehavior } = ensuredEntry;
  void _name;
  void _path;
  void _sk;
  void _originUrl;
  void _ts;

  const sessionPrefix =
    typeof ensuredEntry.sessionPrefix === "string" && ensuredEntry.sessionPrefix.length > 0
      ? ensuredEntry.sessionPrefix
      : generateSessionPrefix(projectId);
  const defaultBranch =
    typeof ensuredEntry.defaultBranch === "string" && ensuredEntry.defaultBranch.length > 0
      ? ensuredEntry.defaultBranch
      : "main";

  if (localConfigResult.kind === "loaded" && localConfigResult.config) {
    // In-project mode: global identity + local behavior (override shadow)
    return {
      name,
      path: projectPath,
      storageKey,
      sessionPrefix,
      defaultBranch,
      ...shadowBehavior,
      ...(localConfigResult.config as Record<string, unknown>),
    };
  }

  const resolveError =
    localConfigResult.kind !== "missing" ? localConfigResult.error ?? "Failed to load local config" : undefined;

  return {
    name,
    path: projectPath,
    storageKey,
    sessionPrefix,
    defaultBranch,
    ...shadowBehavior,
    ...(resolveError ? { resolveError } : {}),
  };
}

// =============================================================================
// STALENESS DETECTION
// =============================================================================

/**
 * Returns true if the local config file is newer than the last shadow sync.
 * Used by `ao status` to warn the user to restart ao.
 */
export function isProjectShadowStale(projectId: string, globalConfig: GlobalConfig): boolean {
  const entry = globalConfig.projects[projectId] as
    | (GlobalProjectEntry & { _shadowSyncedAt?: number })
    | undefined;
  if (!entry) return false;

  const syncedAt = entry._shadowSyncedAt;
  if (!syncedAt) return true; // Never synced

  const projectPath = entry.path as string;
  const candidates = [
    join(projectPath, "agent-orchestrator.yaml"),
    join(projectPath, "agent-orchestrator.yml"),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const stat = statSync(candidate);
      const mtimeSeconds = Math.floor(stat.mtimeMs / 1000);
      return mtimeSeconds > syncedAt;
    } catch {
      return false;
    }
  }

  return false;
}

export function relinkProjectInGlobalConfig(
  projectId: string,
  options: RelinkProjectOptions = {},
  globalConfigPath?: string,
): { oldStorageKey: string; storageKey: string; originUrl: string } {
  const configPath = globalConfigPath ?? getGlobalConfigPath();
  let result: { oldStorageKey: string; storageKey: string; originUrl: string } | null = null;

  withFileLockSync(globalConfigLockPath(configPath), () => {
    const globalConfig = loadGlobalConfig(configPath) ?? makeEmptyGlobalConfig();
    const entry = globalConfig.projects[projectId] as (GlobalProjectEntry & Record<string, unknown>) | undefined;
    if (!entry?.path) {
      throw new Error(`Project "${projectId}" is not registered in the global config.`);
    }

    const currentEntry = ensureProjectStorageIdentity(projectId, globalConfig, configPath, true);
    if (!currentEntry?.path || typeof currentEntry.storageKey !== "string") {
      throw new Error(`Project "${projectId}" could not resolve a storage key.`);
    }

    const oldStorageKey = currentEntry.storageKey;
    const identity = deriveProjectStorageIdentity(currentEntry.path, options.url ?? undefined);
    const nextOriginUrl = identity.originUrl ?? `local://${resolve(identity.gitRoot)}`;
    const nextStorageKey = identity.storageKey;

    if (nextStorageKey === oldStorageKey && nextOriginUrl === currentEntry.originUrl) {
      result = { oldStorageKey, storageKey: nextStorageKey, originUrl: nextOriginUrl };
      return;
    }

    const collisionOwner = findStorageKeyOwner(globalConfig, nextStorageKey, projectId);
    if (collisionOwner) {
      throw new StorageKeyCollisionError(nextStorageKey, collisionOwner, projectId);
    }

    const sessionCount = countSessionEntries(oldStorageKey);
    if (sessionCount > 0 && !options.force) {
      throw new Error(
        `Project "${projectId}" has ${sessionCount} existing session entries. Re-run with --force to relink its storage.`,
      );
    }

    const currentDir = getProjectBaseDir(oldStorageKey);
    const legacyDir = getLegacyProjectBaseDir(oldStorageKey, currentEntry.path);
    const targetDir = getProjectBaseDir(nextStorageKey);
    if (existsSync(currentDir)) {
      moveStorageDirectory(currentDir, targetDir);
    } else if (existsSync(legacyDir)) {
      moveStorageDirectory(legacyDir, targetDir);
    }

    currentEntry.storageKey = nextStorageKey;
    currentEntry.originUrl = nextOriginUrl;
    saveGlobalConfig(globalConfig, configPath);
    result = { oldStorageKey, storageKey: nextStorageKey, originUrl: nextOriginUrl };
  });

  if (!result) {
    throw new Error(`Failed to relink project "${projectId}".`);
  }

  return result;
}

// =============================================================================
// MIGRATION
// =============================================================================

/**
 * Detect if a raw parsed YAML object uses the old single-file config format.
 * Old format: top-level `projects:` map where each entry has `path` + behavior.
 */
export function isOldConfigFormat(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  if (!("projects" in obj) || typeof obj["projects"] !== "object") return false;

  // Confirm at least one project entry has `path` (old format)
  const projects = obj["projects"] as Record<string, unknown>;
  return Object.values(projects).some(
    (entry) =>
      entry !== null && entry !== undefined && typeof entry === "object" && "path" in (entry as Record<string, unknown>),
  );
}

/**
 * Migrate an old single-file config to the new hybrid format.
 *
 * What happens:
 *   1. Read old config from oldConfigPath
 *   2. Create global config at ~/.agent-orchestrator/config.yaml with:
 *      - Global settings (port, defaults, notifiers, reactions)
 *      - Project registry entries (identity) + full behavior as shadow
 *      - _shadowSyncedAt = now (treating existing config as synced)
 *   3. Rewrite local config at oldConfigPath to flat behavior-only format
 *      (removes name, path, sessionPrefix from each project entry, removes
 *       the `projects:` wrapper — only the first/matched project is written
 *       when the old config is inside the project directory)
 *   4. Returns the new global config path
 *
 * The old storage directories (based on sha256(project.path)) remain valid
 * because the hash derivation is unchanged — configPath dirname = project.path.
 *
 * @param oldConfigPath  Absolute path to the old agent-orchestrator.yaml
 * @param globalConfigPath  Override for global config path (default: getGlobalConfigPath())
 * @returns The global config path
 */
export function migrateToGlobalConfig(oldConfigPath: string, globalConfigPath?: string): string {
  const targetGlobalPath = globalConfigPath ?? getGlobalConfigPath();

  const raw = readFileSync(oldConfigPath, "utf-8");
  const parsed = parseYaml(raw) as Record<string, unknown>;

  if (!isOldConfigFormat(parsed)) {
    throw new Error(`File at ${oldConfigPath} is not an old-format config.`);
  }

  const oldProjects = (parsed["projects"] ?? {}) as Record<string, Record<string, unknown>>;

  // Build new global config
  const newGlobal: GlobalConfig = makeEmptyGlobalConfig();

  // Preserve global operational settings
  if (typeof parsed["port"] === "number") newGlobal.port = parsed["port"];
  if (parsed["terminalPort"] !== null && parsed["terminalPort"] !== undefined) newGlobal.terminalPort = parsed["terminalPort"] as number;
  if (parsed["directTerminalPort"] !== null && parsed["directTerminalPort"] !== undefined)
    newGlobal.directTerminalPort = parsed["directTerminalPort"] as number;
  if (parsed["readyThresholdMs"] !== null && parsed["readyThresholdMs"] !== undefined)
    newGlobal.readyThresholdMs = parsed["readyThresholdMs"] as number;
  if (parsed["defaults"] !== null && parsed["defaults"] !== undefined)
    newGlobal.defaults = parsed["defaults"] as GlobalConfig["defaults"];
  if (parsed["notifiers"] !== null && parsed["notifiers"] !== undefined)
    newGlobal.notifiers = parsed["notifiers"] as GlobalConfig["notifiers"];
  if (parsed["notificationRouting"] !== null && parsed["notificationRouting"] !== undefined)
    newGlobal.notificationRouting = parsed[
      "notificationRouting"
    ] as GlobalConfig["notificationRouting"];
  if (parsed["reactions"] !== null && parsed["reactions"] !== undefined)
    newGlobal.reactions = parsed["reactions"] as GlobalConfig["reactions"];

  const now = Math.floor(Date.now() / 1000);

  // Build project registry entries
  for (const [projectId, project] of Object.entries(oldProjects)) {
    if (!project["path"]) continue;

    const projectPath =
      typeof project["path"] === "string" && project["path"].startsWith("~/")
        ? join(homedir(), (project["path"] as string).slice(2))
        : (project["path"] as string);

    // Extract behavior fields (everything except identity + internal)
    const shadowFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(project)) {
      if (key === "name" || key === "path" || key === "sessionPrefix") continue;
      if (key.startsWith(INTERNAL_FIELD_PREFIX)) continue;
      if (SECRET_SUFFIX_PATTERN.test(key)) {
        process.stderr.write(
          `ao: warning — excluding "${key}" from global config during migration (secret-like field name). ` +
            `Use environment variables for secrets.\n`,
        );
        continue;
      }
      shadowFields[key] = value;
    }

    newGlobal.projects[projectId] = {
      name: (project["name"] as string | undefined) ?? projectId,
      path: projectPath,
      ...(typeof project["sessionPrefix"] === "string"
        ? { sessionPrefix: project["sessionPrefix"] as string }
        : {}),
      ...shadowFields,
      _shadowSyncedAt: now,
    };
  }

  // Write global config atomically
  saveGlobalConfig(newGlobal, targetGlobalPath);

  // Rewrite each old project's local config to flat format.
  // Each old project had its config inside the multi-project file.
  // For single-project configs at the project root: rewrite in place.
  // For multi-project configs: write each project's local config to its path.
  const oldConfigDir = dirname(resolve(oldConfigPath));
  for (const [_projectId, project] of Object.entries(oldProjects)) {
    if (!project["path"]) continue;

    const projectPath =
      typeof project["path"] === "string" && project["path"].startsWith("~/")
        ? join(homedir(), (project["path"] as string).slice(2))
        : (project["path"] as string);

    // Only rewrite if the old config lives inside this project's directory
    // (single-project setup: the config IS in the project root)
    if (resolve(projectPath) !== resolve(oldConfigDir)) continue;

    const {
      name: _name,
      path: _path,
      sessionPrefix: _sessionPrefix,
      ...behaviorFields
    } = project;
    void _name;
    void _path;
    void _sessionPrefix;
    const localBehaviorFields = Object.fromEntries(
      Object.entries(behaviorFields).filter(([key]) => !key.startsWith(INTERNAL_FIELD_PREFIX)),
    );

    // Write flat local config
    const localConfigPath = join(projectPath, basename(oldConfigPath));
    atomicWriteFileSync(localConfigPath, stringifyYaml(localBehaviorFields, { indent: 2 }));
  }

  return targetGlobalPath;
}

// =============================================================================
// HELPERS
// =============================================================================

function makeEmptyGlobalConfig(): GlobalConfig {
  return {
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["composio", "desktop"],
    },
    projects: {},
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop", "composio"],
      action: ["desktop", "composio"],
      warning: ["composio"],
      info: ["composio"],
    },
    reactions: {},
  };
}
