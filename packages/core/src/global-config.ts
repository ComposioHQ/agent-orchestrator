import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { atomicWriteFileSync } from "./atomic-write.js";
import { detectScmPlatform } from "./config-generator.js";
import { withFileLockSync } from "./file-lock.js";
import { ProjectResolveError } from "./types.js";
import { generateSessionPrefix, getAoBaseDir, getProjectBaseDir, getSessionsDir } from "./paths.js";
import { deriveStorageKey, normalizeOriginUrl } from "./storage-key.js";

function globalConfigLockPath(configPath: string): string {
  return `${configPath}.lock`;
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

function normalizeRegistryProjectPath(projectId: string, rawPath: string): string {
  if (rawPath === "~") {
    return homedir();
  }

  if (rawPath.startsWith("~/")) {
    const homePath = homedir();
    const resolvedPath = resolve(homePath, rawPath.slice(2));
    if (!isWithinRoot(homePath, resolvedPath)) {
      throw new ProjectResolveError(
        projectId,
        `Project path "${rawPath}" escapes the home directory and cannot be loaded from the global registry.`,
      );
    }
    return resolvedPath;
  }

  return resolve(rawPath);
}

function normalizeRegisteredProjectPath(projectPath: string): string {
  return realpathSync(resolve(projectPath));
}

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
 * YAML when registry helpers call this function.
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

export function isCanonicalGlobalConfigPath(configPath: string | undefined): boolean {
  if (!configPath) return false;
  return resolve(configPath) === resolve(getGlobalConfigPath());
}

// =============================================================================
// GLOBAL CONFIG SCHEMA
// =============================================================================

const GlobalRepoIdentitySchema = z.object({
  owner: z.string(),
  name: z.string(),
  platform: z.enum(["github", "gitlab", "bitbucket"]),
  originUrl: z.string(),
});

const GLOBAL_PROJECT_ENTRY_FIELDS = new Set([
  "projectId",
  "path",
  "storageKey",
  "repo",
  "defaultBranch",
  "source",
  "registeredAt",
  "displayName",
  "sessionPrefix",
]);

const LOCAL_CONFIG_FILENAMES = ["agent-orchestrator.yaml", "agent-orchestrator.yml"] as const;
const LOCAL_IDENTITY_FIELDS = new Set([
  "repo",
  "defaultBranch",
  "originUrl",
  "projectId",
  "path",
  "storageKey",
]);

export const GlobalProjectEntrySchema = z.object({
  projectId: z.string().optional(),
  path: z.string(),
  storageKey: z.string().optional(),
  repo: GlobalRepoIdentitySchema.optional(),
  defaultBranch: z.string().optional(),
  source: z.string().optional(),
  registeredAt: z.number().optional(),
  displayName: z.string().optional(),
  sessionPrefix: z.string().optional(),
});

export type GlobalProjectEntry = z.infer<typeof GlobalProjectEntrySchema>;

/**
 * Global config schema.
 * Operational settings + project registry with identity fields only.
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
 * Does NOT contain identity fields: projectId, path, storageKey, repo,
 * defaultBranch, source, registeredAt, displayName, sessionPrefix.
 * Those are owned by the global registry.
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
  path?: string;
}

interface RawGlobalConfigProjectSanitization {
  strippedFieldCount: number;
}

interface RawGlobalConfigSanitization {
  changed: boolean;
  strippedProjects: Array<{ projectId: string; strippedFieldCount: number }>;
}

interface GlobalConfigMigrationResult {
  parsed: Record<string, unknown> | null;
  migrationSummary: string | null;
}

// =============================================================================
// LOAD / SAVE
// =============================================================================

/**
 * Load and validate the global config.
 * Returns null if the file does not exist (not an error — first run).
 */
export function loadGlobalConfig(
  configPath?: string,
  options: { alreadyLocked?: boolean } = {},
): GlobalConfig | null {
  const path = configPath ?? getGlobalConfigPath();
  if (!existsSync(path)) return null;

  const { parsed, migrationSummary } = migrateLegacyGlobalConfigOnLoad(path, options);
  if (!parsed) return null;

  if (migrationSummary) {
    // eslint-disable-next-line no-console -- required migration visibility for stale shadow stripping
    console.info(migrationSummary);
  }

  const config = GlobalConfigSchema.parse(parsed);

  for (const [projectId, entry] of Object.entries(config.projects)) {
    entry.path = normalizeRegistryProjectPath(projectId, entry.path);
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
  return result.kind === "loaded" ? (result.config ?? null) : null;
}

export function loadLocalProjectConfigDetailed(projectPath: string): LocalProjectConfigLoadResult {
  const candidates = LOCAL_CONFIG_FILENAMES.map((filename) => join(projectPath, filename));

  for (const path of candidates) {
    if (!existsSync(path)) continue;

    let parsed: unknown;
    try {
      const raw = readFileSync(path, "utf-8");
      parsed = parseYaml(raw);
    } catch (error) {
      return {
        kind: "malformed",
        path,
        error: `Failed to parse local config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!parsed || typeof parsed !== "object") {
      return {
        kind: "invalid",
        path,
        error: `Local config at ${path} must parse to an object`,
      };
    }

    // Old format: has `projects:` wrapper → not a flat local config
    if ("projects" in (parsed as Record<string, unknown>)) {
      return {
        kind: "old-format",
        path,
        error: `Local config at ${path} still uses a wrapped projects: format`,
      };
    }

    try {
      return {
        kind: "loaded",
        path,
        config: LocalProjectConfigSchema.parse(parsed),
      };
    } catch (error) {
      return {
        kind: "invalid",
        path,
        error: `Local config at ${path} failed validation: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return { kind: "missing" };
}

function stripLocalIdentityFields(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config };
  for (const key of LOCAL_IDENTITY_FIELDS) {
    Reflect.deleteProperty(next, key);
  }
  return next;
}

export function getLocalProjectConfigPath(projectPath: string): string {
  for (const filename of LOCAL_CONFIG_FILENAMES) {
    const candidate = join(projectPath, filename);
    if (existsSync(candidate)) return candidate;
  }

  return join(projectPath, LOCAL_CONFIG_FILENAMES[0]);
}

export function writeLocalProjectConfig(
  projectPath: string,
  config: LocalProjectConfig,
  configPath = getLocalProjectConfigPath(projectPath),
): string {
  mkdirSync(dirname(configPath), { recursive: true });
  const validated = LocalProjectConfigSchema.parse(
    stripLocalIdentityFields(config as Record<string, unknown>),
  );
  atomicWriteFileSync(configPath, stringifyYaml(validated, { indent: 2 }));
  return configPath;
}

export function repairWrappedLocalProjectConfig(projectId: string, projectPath: string): void {
  const localConfigResult = loadLocalProjectConfigDetailed(projectPath);
  if (localConfigResult.kind !== "old-format" || !localConfigResult.path) {
    throw new Error(`No wrapped local config found for project "${projectId}" at ${projectPath}`);
  }
  const configPath = localConfigResult.path;

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || !isOldConfigFormat(parsed)) {
    throw new Error(`Local config at ${configPath} is not a wrapped old-format config.`);
  }

  const projects = (parsed["projects"] ?? {}) as Record<string, Record<string, unknown>>;
  const project = projects[projectId];
  if (!project || typeof project !== "object") {
    throw new Error(
      `Wrapped local config at ${configPath} does not contain project "${projectId}".`,
    );
  }

  const {
    name: _name,
    path: _path,
    sessionPrefix: _sessionPrefix,
    storageKey: _storageKey,
    originUrl: _originUrl,
    projectId: _projectId,
    source: _source,
    registeredAt: _registeredAt,
    displayName: _displayName,
    ...behaviorFields
  } = project;
  void _name;
  void _path;
  void _sessionPrefix;
  void _storageKey;
  void _originUrl;
  void _projectId;
  void _source;
  void _registeredAt;
  void _displayName;

  writeLocalProjectConfig(projectPath, behaviorFields, configPath);
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

function deriveProjectStorageIdentity(
  projectPath: string,
  originUrlOverride?: string | null,
): StorageIdentity {
  const gitRoot = resolveGitRoot(projectPath);
  const rawOriginUrl =
    originUrlOverride !== undefined ? originUrlOverride : readOriginUrlFromGitConfig(projectPath);
  const originUrl = rawOriginUrl === null ? null : normalizeOriginUrl(rawOriginUrl);
  return {
    gitRoot,
    originUrl,
    storageKey: deriveStorageKey({ originUrl, gitRoot, projectPath }),
  };
}

function normalizeRepoIdentity(
  originUrl: string | null,
): z.infer<typeof GlobalRepoIdentitySchema> | undefined {
  if (!originUrl) return undefined;

  const normalizedOriginUrl = normalizeOriginUrl(originUrl);
  if (!normalizedOriginUrl.startsWith("https://")) return undefined;

  try {
    const parsed = new URL(normalizedOriginUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return undefined;

    const name = segments[segments.length - 1];
    const owner = segments.slice(0, -1).join("/");
    const platform = detectScmPlatform(parsed.host);
    if (platform === "unknown") return undefined;

    return {
      owner,
      name,
      platform,
      originUrl: normalizedOriginUrl,
    };
  } catch {
    return undefined;
  }
}

function normalizeLegacyRepoValue(
  repoValue: unknown,
): z.infer<typeof GlobalRepoIdentitySchema> | undefined {
  if (typeof repoValue !== "string") return undefined;

  const trimmed = repoValue.trim();
  if (!trimmed) return undefined;

  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("git@")
  ) {
    return normalizeRepoIdentity(trimmed);
  }

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 2) {
    return normalizeRepoIdentity(`https://github.com/${segments[0]}/${segments[1]}`);
  }

  if (segments.length >= 3 && segments[0].includes(".")) {
    const host = segments[0];
    const platform = detectScmPlatform(host);
    if (platform === "unknown") return undefined;
    const owner = segments.slice(1, -1).join("/");
    const name = segments[segments.length - 1];
    return normalizeRepoIdentity(`https://${host}/${owner}/${name}`);
  }

  return undefined;
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

function getLegacyWrappedStorageKey(configPath: string, projectPath: string): string {
  const configDir = dirname(realpathSync(configPath));
  const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 12);
  return `${hash}-${basename(projectPath)}`;
}

function getRegisteredSessionPrefix(entry: GlobalProjectEntry, projectId: string): string {
  return entry.sessionPrefix ?? generateSessionPrefix(basename(entry.path ?? projectId));
}

function findSessionPrefixOwner(
  globalConfig: GlobalConfig,
  sessionPrefix: string,
  excludeProjectId?: string,
): string | null {
  for (const [projectId, entry] of Object.entries(globalConfig.projects)) {
    if (projectId === excludeProjectId) continue;
    if (getRegisteredSessionPrefix(entry, projectId) === sessionPrefix) {
      return projectId;
    }
  }
  return null;
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
  const entry = globalConfig.projects[projectId] as
    | (GlobalProjectEntry & Record<string, unknown>)
    | undefined;
  if (!entry?.path) return null;

  if (typeof entry.storageKey === "string") {
    return entry;
  }

  const projectPath = entry.path;
  const identity = deriveProjectStorageIdentity(projectPath);
  const nextStorageKey = identity.storageKey;
  const owner = findStorageKeyOwner(globalConfig, nextStorageKey, projectId);
  if (owner) {
    throw new StorageKeyCollisionError(nextStorageKey, owner, projectId);
  }

  const configPath = globalConfigPath ?? getGlobalConfigPath();
  const migrate = () => {
    const fresh = loadGlobalConfig(configPath, { alreadyLocked: true }) ?? globalConfig;
    const freshEntry = fresh.projects[projectId] as
      | (GlobalProjectEntry & Record<string, unknown>)
      | undefined;
    if (!freshEntry?.path) return;

    const freshOldStorageKey =
      typeof freshEntry.storageKey === "string"
        ? freshEntry.storageKey
        : legacyProjectHash(freshEntry.path);
    const freshIdentity = deriveProjectStorageIdentity(
      freshEntry.path,
      typeof freshEntry.repo?.originUrl === "string" ? freshEntry.repo.originUrl : undefined,
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

    freshEntry.projectId = projectId;
    freshEntry.storageKey = freshIdentity.storageKey;
    if (!freshEntry.repo) {
      freshEntry.repo = normalizeRepoIdentity(freshIdentity.originUrl);
    }
    saveGlobalConfig(fresh, configPath);

    entry.storageKey = freshEntry.storageKey;
    entry.repo = freshEntry.repo;
    // eslint-disable-next-line no-console -- required migration visibility for storage identity updates
    console.info(
      `[ao] migrated storage identity for "${projectId}" to "${freshEntry.storageKey}" (${freshEntry.repo?.originUrl ?? `local://${resolve(freshIdentity.gitRoot)}`})`,
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
// REGISTRATION
// =============================================================================

/**
 * Register or update a project in the global registry.
 *
 * - If the project already exists, identity fields are preserved and only
 *   updated if explicitly provided.
 * - Local behavior is never written into the registry.
 * - Write is atomic.
 */
export function registerProjectInGlobalConfig(
  projectId: string,
  name: string,
  projectPath: string,
  localConfig?: (LocalProjectConfig & { sessionPrefix?: string }) | undefined,
  optionsOrGlobalConfigPath?: RegisterProjectOptions | string,
  globalConfigPath?: string,
): void {
  const options =
    typeof optionsOrGlobalConfigPath === "string" ? {} : (optionsOrGlobalConfigPath ?? {});
  const configPath =
    typeof optionsOrGlobalConfigPath === "string"
      ? optionsOrGlobalConfigPath
      : (globalConfigPath ?? getGlobalConfigPath());
  const requestedProjectPath = resolve(projectPath);
  const normalizedProjectPath = normalizeRegisteredProjectPath(projectPath);
  const identity = deriveProjectStorageIdentity(normalizedProjectPath);

  withFileLockSync(globalConfigLockPath(configPath), () => {
    const globalConfig =
      loadGlobalConfig(configPath, { alreadyLocked: true }) ?? makeEmptyGlobalConfig();

    const existing = globalConfig.projects[projectId] as
      | (GlobalProjectEntry & Record<string, unknown>)
      | undefined;

    if (existing?.path && resolve(existing.path) !== normalizedProjectPath) {
      throw new Error(
        `Project id "${projectId}" is already registered for "${existing.path}". ` +
          `Choose a different configProjectKey to add "${normalizedProjectPath}" as a separate project.`,
      );
    }

    for (const [existingProjectId, entry] of Object.entries(globalConfig.projects)) {
      if (existingProjectId === projectId) continue;
      if (entry.path === normalizedProjectPath) {
        if (!options.allowStorageKeyReuse) {
          throw new StorageKeyCollisionError(
            entry.storageKey ?? identity.storageKey,
            existingProjectId,
            projectId,
          );
        }
      }
    }

    const storageKey = (existing?.storageKey as string | undefined) ?? identity.storageKey;
    const collisionOwner = findStorageKeyOwner(globalConfig, storageKey, projectId);
    if (collisionOwner && !options.allowStorageKeyReuse) {
      throw new StorageKeyCollisionError(storageKey, collisionOwner, projectId);
    }

    const repoIdentity = existing?.repo ?? normalizeRepoIdentity(identity.originUrl);
    const defaultBranch = existing?.defaultBranch ?? localConfig?.defaultBranch ?? "main";
    const sessionPrefix =
      existing?.sessionPrefix ??
      localConfig?.sessionPrefix ??
      generateSessionPrefix(basename(requestedProjectPath));
    const source = existing?.source ?? (repoIdentity ? "ao-project-add" : "local");
    const registeredAt = existing?.registeredAt ?? Math.floor(Date.now() / 1000);
    const prefixOwner = findSessionPrefixOwner(globalConfig, sessionPrefix, projectId);

    if (prefixOwner) {
      throw new Error(
        `Duplicate session prefix detected: "${sessionPrefix}"\n` +
          `Projects "${prefixOwner}" and "${projectId}" would generate the same prefix.\n\n` +
          `Choose a different configProjectKey or add an explicit sessionPrefix before registering the project.`,
      );
    }

    globalConfig.projects[projectId] = {
      projectId,
      path: normalizedProjectPath,
      storageKey,
      ...(repoIdentity ? { repo: repoIdentity } : {}),
      defaultBranch,
      source,
      registeredAt,
      displayName: name,
      sessionPrefix,
    };

    saveGlobalConfig(globalConfig, configPath);
  });
}

// =============================================================================
// EFFECTIVE CONFIG BUILD
// =============================================================================

/**
 * Build effective project configuration by merging global registry identity
 * with local behavior config.
 *
 * Load order:
 *   1. Global entry supplies identity
 *   2. Local flat config (if present) supplies behavior
 *   3. Shared defaults supply missing required behavior when local config is absent
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
 *   2. Local flat config overrides shared defaults when it loads cleanly
 *   3. Shared defaults are used when local config is missing
 *   4. When local config is broken, resolveError is attached instead of throwing
 */
export function resolveProjectIdentity(
  projectId: string,
  globalConfig: GlobalConfig,
  globalConfigPath?: string,
):
  | (Record<string, unknown> & {
      name: string;
      path: string;
      storageKey: string;
      originUrl?: string;
      repo?: string;
      defaultBranch: string;
      sessionPrefix: string;
      resolveError?: string;
    })
  | null {
  const entry = globalConfig.projects[projectId] as
    | (GlobalProjectEntry & Record<string, unknown>)
    | undefined;
  if (!entry || !entry.path) return null;

  const ensuredEntry = ensureProjectStorageIdentity(projectId, globalConfig, globalConfigPath);
  if (!ensuredEntry) return null;

  const projectPath = ensuredEntry.path as string;
  const name = (ensuredEntry.displayName as string | undefined) ?? projectId;
  const storageKey = ensuredEntry.storageKey as string;
  const sessionPrefix =
    typeof ensuredEntry.sessionPrefix === "string" && ensuredEntry.sessionPrefix.length > 0
      ? ensuredEntry.sessionPrefix
      : generateSessionPrefix(basename(projectPath));
  const defaultBranch =
    typeof ensuredEntry.defaultBranch === "string" && ensuredEntry.defaultBranch.length > 0
      ? ensuredEntry.defaultBranch
      : "main";
  const repoString =
    ensuredEntry.repo &&
    typeof ensuredEntry.repo.owner === "string" &&
    typeof ensuredEntry.repo.name === "string"
      ? `${ensuredEntry.repo.owner}/${ensuredEntry.repo.name}`
      : undefined;
  const identityFields = {
    name,
    path: projectPath,
    storageKey,
    ...(repoString ? { repo: repoString } : {}),
    ...(ensuredEntry.repo?.originUrl ? { originUrl: ensuredEntry.repo.originUrl } : {}),
    sessionPrefix,
    defaultBranch,
  };

  const applyBehaviorDefaults = (behavior: Record<string, unknown>): Record<string, unknown> => {
    const merged: Record<string, unknown> = { ...behavior };
    const defaults = globalConfig.defaults ?? {};

    if (merged["runtime"] === undefined) merged["runtime"] = defaults.runtime;
    if (merged["agent"] === undefined) merged["agent"] = defaults.agent;
    if (merged["workspace"] === undefined) merged["workspace"] = defaults.workspace;

    const orchestrator = {
      ...(defaults.orchestrator ?? {}),
      ...((merged["orchestrator"] as Record<string, unknown> | undefined) ?? {}),
    };
    if (Object.keys(orchestrator).length > 0) {
      merged["orchestrator"] = orchestrator;
    }

    const worker = {
      ...(defaults.worker ?? {}),
      ...((merged["worker"] as Record<string, unknown> | undefined) ?? {}),
    };
    if (Object.keys(worker).length > 0) {
      merged["worker"] = worker;
    }

    const missing = ["runtime", "agent", "workspace"].filter((field) => {
      const value = merged[field];
      return typeof value !== "string" || value.length === 0;
    });
    if (missing.length > 0) {
      throw new ProjectResolveError(
        projectId,
        `Project "${projectId}" is missing required behavior fields with no defaults: ${missing.join(", ")}`,
      );
    }

    return merged;
  };

  const localConfigResult = loadLocalProjectConfigDetailed(projectPath);

  if (localConfigResult.kind === "loaded" && localConfigResult.config) {
    return {
      ...applyBehaviorDefaults(
        stripLocalIdentityFields(localConfigResult.config as Record<string, unknown>),
      ),
      ...identityFields,
    };
  }

  const resolveError =
    localConfigResult.kind !== "missing"
      ? (localConfigResult.error ?? "Failed to load local config")
      : undefined;

  return {
    ...(resolveError ? {} : applyBehaviorDefaults({})),
    ...identityFields,
    ...(resolveError ? { resolveError } : {}),
  };
}

export function relinkProjectInGlobalConfig(
  projectId: string,
  options: RelinkProjectOptions = {},
  globalConfigPath?: string,
): { oldStorageKey: string; storageKey: string; originUrl: string } {
  const configPath = globalConfigPath ?? getGlobalConfigPath();
  let result: { oldStorageKey: string; storageKey: string; originUrl: string } | null = null;

  withFileLockSync(globalConfigLockPath(configPath), () => {
    const globalConfig =
      loadGlobalConfig(configPath, { alreadyLocked: true }) ?? makeEmptyGlobalConfig();
    const entry = globalConfig.projects[projectId] as
      | (GlobalProjectEntry & Record<string, unknown>)
      | undefined;
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

    if (nextStorageKey === oldStorageKey && nextOriginUrl === currentEntry.repo?.originUrl) {
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
    currentEntry.repo = normalizeRepoIdentity(nextOriginUrl);
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
      entry !== null &&
      entry !== undefined &&
      typeof entry === "object" &&
      "path" in (entry as Record<string, unknown>),
  );
}

/**
 * Migrate an old single-file config to the new hybrid format.
 *
 * What happens:
 *   1. Read old config from oldConfigPath
 *   2. Create global config at ~/.agent-orchestrator/config.yaml with:
 *      - Global settings (port, defaults, notifiers, reactions)
 *      - Project registry entries (identity only)
 *   3. Rewrite local config at oldConfigPath to flat behavior-only format
 *      (removes name, path, sessionPrefix from each project entry, removes
 *       the `projects:` wrapper — only the first/matched project is written
 *       when the old config is inside the project directory)
 *   4. Returns the new global config path
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
  if (parsed["terminalPort"] !== null && parsed["terminalPort"] !== undefined)
    newGlobal.terminalPort = parsed["terminalPort"] as number;
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

  // Build project registry entries
  for (const [projectId, project] of Object.entries(oldProjects)) {
    if (!project["path"]) continue;

    const projectPath =
      typeof project["path"] === "string" && project["path"].startsWith("~/")
        ? join(homedir(), (project["path"] as string).slice(2))
        : (project["path"] as string);
    const storageKey =
      typeof project["storageKey"] === "string"
        ? (project["storageKey"] as string)
        : getLegacyWrappedStorageKey(oldConfigPath, projectPath);

    const repoIdentity =
      typeof project["originUrl"] === "string"
        ? normalizeRepoIdentity(project["originUrl"] as string)
        : undefined;
    newGlobal.projects[projectId] = {
      projectId,
      path: projectPath,
      storageKey,
      ...(repoIdentity ? { repo: repoIdentity } : {}),
      ...(typeof project["defaultBranch"] === "string"
        ? { defaultBranch: project["defaultBranch"] as string }
        : {}),
      source: "migrated",
      registeredAt: Math.floor(Date.now() / 1000),
      displayName: (project["name"] as string | undefined) ?? projectId,
      ...(typeof project["sessionPrefix"] === "string"
        ? { sessionPrefix: project["sessionPrefix"] as string }
        : {}),
    };
  }

  // Write global config atomically
  saveGlobalConfig(newGlobal, targetGlobalPath);

  // Rewrite each old project's local config to flat format.
  // Each old project had its config inside the multi-project file.
  // For single-project configs at the project root: rewrite in place.
  // For multi-project configs: write each project's local config to its path.
  for (const [_projectId, project] of Object.entries(oldProjects)) {
    if (!project["path"]) continue;

    const projectPath =
      typeof project["path"] === "string" && project["path"].startsWith("~/")
        ? join(homedir(), (project["path"] as string).slice(2))
        : (project["path"] as string);

    const {
      name: _name,
      path: _path,
      sessionPrefix: _sessionPrefix,
      storageKey: _storageKey,
      originUrl: _originUrl,
      ...behaviorFields
    } = project;
    void _name;
    void _path;
    void _sessionPrefix;
    void _storageKey;
    void _originUrl;
    const localBehaviorFields = behaviorFields;

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

function sanitizeRawGlobalConfig(raw: Record<string, unknown>): RawGlobalConfigSanitization {
  const projects = raw["projects"];
  if (!projects || typeof projects !== "object") {
    return { changed: false, strippedProjects: [] };
  }

  let changed = false;
  const strippedProjects: Array<{ projectId: string; strippedFieldCount: number }> = [];

  for (const [projectId, value] of Object.entries(projects as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const hadLegacyAliases =
      entry["projectId"] !== projectId ||
      (typeof entry["name"] === "string" && typeof entry["displayName"] !== "string") ||
      typeof entry["repo"] === "string" ||
      (typeof entry["originUrl"] === "string" && entry["repo"] === undefined);
    const result = sanitizeRawGlobalProjectEntry(projectId, value as Record<string, unknown>);

    if (result.strippedFieldCount > 0) {
      strippedProjects.push({ projectId, strippedFieldCount: result.strippedFieldCount });
    }
    if (result.strippedFieldCount > 0 || hadLegacyAliases) {
      changed = true;
    }
  }

  return { changed, strippedProjects };
}

function migrateLegacyGlobalConfigOnLoad(
  configPath: string,
  options: { alreadyLocked?: boolean },
): GlobalConfigMigrationResult {
  let parsed = readRawGlobalConfig(configPath);
  if (!parsed) {
    return { parsed: null, migrationSummary: null };
  }

  const initialSanitization = sanitizeRawGlobalConfig(parsed);
  if (!initialSanitization.changed) {
    return { parsed, migrationSummary: null };
  }

  let migrationSummary: string | null = null;
  const rewrite = () => {
    const freshParsed = readRawGlobalConfig(configPath);
    if (!freshParsed) {
      parsed = null;
      return;
    }

    const freshSanitization = sanitizeRawGlobalConfig(freshParsed);
    parsed = freshParsed;
    if (!freshSanitization.changed) return;

    migrationSummary = formatGlobalConfigMigrationLog(freshSanitization);
    saveGlobalConfig(GlobalConfigSchema.parse(freshParsed), configPath);
  };

  if (options.alreadyLocked) {
    rewrite();
  } else {
    withFileLockSync(globalConfigLockPath(configPath), rewrite);
  }

  return { parsed, migrationSummary };
}

function readRawGlobalConfig(configPath: string): Record<string, unknown> | null {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as Record<string, unknown>;
}

function formatGlobalConfigMigrationLog(sanitization: RawGlobalConfigSanitization): string | null {
  if (sanitization.strippedProjects.length === 0) {
    return "[ao] migrated legacy project registry fields in global config";
  }

  const totalFieldCount = sanitization.strippedProjects.reduce(
    (sum, project) => sum + project.strippedFieldCount,
    0,
  );
  const projectSummary = sanitization.strippedProjects
    .map((project) => `${project.projectId} (${project.strippedFieldCount})`)
    .join(", ");

  return `[ao] stripped ${totalFieldCount} legacy project registry fields from ${sanitization.strippedProjects.length} project${sanitization.strippedProjects.length === 1 ? "" : "s"}: ${projectSummary}`;
}

function sanitizeRawGlobalProjectEntry(
  projectId: string,
  entry: Record<string, unknown>,
): RawGlobalConfigProjectSanitization {
  let strippedFieldCount = 0;

  entry["projectId"] = projectId;

  if (typeof entry["name"] === "string" && typeof entry["displayName"] !== "string") {
    entry["displayName"] = entry["name"];
  }

  if (typeof entry["originUrl"] === "string" && entry["repo"] === undefined) {
    const repoIdentity = normalizeRepoIdentity(entry["originUrl"] as string);
    if (repoIdentity) {
      entry["repo"] = repoIdentity;
    }
  }

  if (typeof entry["repo"] === "string") {
    const repoIdentity = normalizeLegacyRepoValue(entry["repo"]);
    if (repoIdentity) {
      entry["repo"] = repoIdentity;
    } else {
      delete entry["repo"];
    }
  }

  delete entry["name"];
  delete entry["originUrl"];

  for (const key of Object.keys(entry)) {
    if (GLOBAL_PROJECT_ENTRY_FIELDS.has(key)) continue;
    Reflect.deleteProperty(entry, key);
    strippedFieldCount += 1;
  }

  return { strippedFieldCount };
}
