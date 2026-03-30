/**
 * Migration: single-project → multi-project format.
 *
 * Detects old-format config (has `projects:` with identity + behavior mixed),
 * creates global config, rewrites local config to flat behavior-only format,
 * and creates symlinks from old storage hash dirs to new ones.
 *
 * This is a one-way migration. The old format is not supported after migration.
 */

import { readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync, renameSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  type GlobalConfig,
  type GlobalProjectEntry,
  saveGlobalConfig,
  findGlobalConfigPath,
  isOldConfigFormat,
  isSecretField,
  filterSecrets,
} from "./global-config.js";
import {
  generateConfigHash,
  generateSessionPrefix,
  expandHome,
  generateProjectId,
} from "./paths.js";
import {
  detectConfigMode,
  findLocalConfigPath,
  loadLocalProjectConfig,
} from "./global-config.js";

// =============================================================================
// TYPES
// =============================================================================

export interface MigrationResult {
  /** Whether migration was performed */
  migrated: boolean;
  /** Path to the global config file */
  globalConfigPath: string;
  /** Project IDs that were registered */
  registeredProjects: string[];
  /** Session counts preserved per project */
  sessionCounts: Record<string, number>;
  /** Warnings generated during migration */
  warnings: string[];
}

// =============================================================================
// DETECTION
// =============================================================================

/**
 * Detect if a config file needs migration.
 * Returns true if the file exists and uses the old single-project format.
 */
export function needsMigration(configPath: string): boolean {
  if (!existsSync(configPath)) return false;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw);
    return isOldConfigFormat(parsed);
  } catch {
    return false;
  }
}

// =============================================================================
// MIGRATION
// =============================================================================

/**
 * Migrate a single-project config to multi-project format.
 *
 * Steps:
 * 1. Parse old config to extract projects with mixed identity + behavior
 * 2. Create global config with project registry + shadows
 * 3. Rewrite local config to flat behavior-only format (strip identity fields)
 * 4. Symlink old storage directories to new hash-based directories
 *
 * @param configPath Path to the old-format config file
 * @returns MigrationResult describing what was done
 */
export function migrateToMultiProject(configPath: string): MigrationResult {
  const warnings: string[] = [];
  const registeredProjects: string[] = [];
  const sessionCounts: Record<string, number> = {};

  // 1. Parse old config
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw) as Record<string, unknown>;

  if (!isOldConfigFormat(parsed)) {
    return {
      migrated: false,
      globalConfigPath: findGlobalConfigPath(),
      registeredProjects: [],
      sessionCounts: {},
      warnings: ["Config is not in old format — no migration needed"],
    };
  }

  const oldProjects = parsed["projects"] as Record<string, Record<string, unknown>>;

  // 2. Build global config
  const globalConfig: GlobalConfig = {
    port: (parsed["port"] as number) ?? 3000,
    terminalPort: parsed["terminalPort"] as number | undefined,
    directTerminalPort: parsed["directTerminalPort"] as number | undefined,
    readyThresholdMs: (parsed["readyThresholdMs"] as number) ?? 300_000,
    defaults: (parsed["defaults"] as GlobalConfig["defaults"]) ?? {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["composio", "desktop"],
    },
    projects: {},
    notifiers: (parsed["notifiers"] as GlobalConfig["notifiers"]) ?? {},
    notificationRouting: (parsed["notificationRouting"] as GlobalConfig["notificationRouting"]) ?? {
      urgent: ["desktop", "composio"],
      action: ["desktop", "composio"],
      warning: ["composio"],
      info: ["composio"],
    },
    reactions: (parsed["reactions"] as GlobalConfig["reactions"]) ?? {},
  };

  // Identity fields that should NOT be in local config
  const identityFields = new Set(["name", "path", "sessionPrefix"]);

  // Compute the old storage hash BEFORE renaming, since generateConfigHash
  // calls realpathSync which requires the file to exist.
  const oldStorageHash = generateConfigHash(configPath);

  // Compute the runtime hash that getProjectBaseDir(globalConfigPath, ...)
  // will produce after migration. generateConfigHash does:
  //   realpathSync(configPath) → dirname → sha256 → slice(0,12)
  // The global config will be at ~/.agent-orchestrator/config.yaml,
  // so dirname is the resolved ~/.agent-orchestrator/ path.
  const globalDir = resolve(homedir(), ".agent-orchestrator");
  const resolvedGlobalDir = existsSync(globalDir)
    ? realpathSync(globalDir)
    : globalDir;
  const runtimeHash = createHash("sha256").update(resolvedGlobalDir).digest("hex").slice(0, 12);

  // Backup the original config BEFORE writing any flat local configs.
  // This prevents overwriting the original when configPath is inside a
  // project directory (the common single-project case).
  const backupPath = configPath + ".pre-multiproject.bak";
  try {
    if (existsSync(configPath) && !existsSync(backupPath)) {
      renameSync(configPath, backupPath);
    }
  } catch {
    warnings.push(
      `Could not rename old config at ${configPath} — re-migration may occur on next start.`,
    );
  }

  // Track used IDs to detect collisions within this migration
  const usedIds = new Set<string>();

  for (const [configKey, projectRaw] of Object.entries(oldProjects)) {
    const projectPath = expandHome(String(projectRaw["path"] ?? ""));
    let projectId = generateSessionPrefix(generateProjectId(projectPath));

    // Handle ID collision: append numeric suffix until unique
    if (usedIds.has(projectId)) {
      let suffix = 2;
      while (usedIds.has(`${projectId}${suffix}`)) suffix++;
      const newId = `${projectId}${suffix}`;
      warnings.push(
        `ID collision: "${configKey}" derived ID "${projectId}" already taken. Using "${newId}" instead.`,
      );
      projectId = newId;
    }
    usedIds.add(projectId);

    // Build global registry entry (identity + shadow)
    const globalEntry: GlobalProjectEntry = {
      name: String(projectRaw["name"] ?? configKey),
      path: projectRaw["path"] as string,
      _shadowSyncedAt: Math.floor(Date.now() / 1000),
    };

    // Copy all non-identity, non-secret fields to shadow
    for (const [key, value] of Object.entries(projectRaw)) {
      if (identityFields.has(key)) continue;
      if (isSecretField(key)) {
        warnings.push(`Excluded secret-like field "${key}" from shadow for "${configKey}"`);
        continue;
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const excluded: string[] = [];
        (globalEntry as Record<string, unknown>)[key] = filterSecrets(
          value as Record<string, unknown>, excluded, key,
        );
        for (const e of excluded) {
          warnings.push(`Excluded secret-like field "${e}" from shadow for "${configKey}"`);
        }
      } else {
        (globalEntry as Record<string, unknown>)[key] = value;
      }
    }

    globalConfig.projects[projectId] = globalEntry;
    registeredProjects.push(projectId);

    // 3. Build flat local config (behavior only, strip identity)
    const localConfig: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(projectRaw)) {
      if (!identityFields.has(key)) {
        localConfig[key] = value;
      }
    }

    // Write flat local config (overwrite the project's local config)
    const localConfigPath = join(projectPath, "agent-orchestrator.yaml");
    if (existsSync(projectPath)) {
      try {
        const yaml = stringifyYaml(localConfig, { lineWidth: 0 });
        writeFileSync(localConfigPath, yaml, "utf-8");
      } catch (err) {
        warnings.push(`Failed to write local config for "${configKey}": ${err}`);
      }
    } else {
      warnings.push(`Project path does not exist: ${projectPath} — skipping local config rewrite`);
    }

    // 4. Create symlink from old storage dir to runtime storage dir.
    // oldStorageHash and runtimeHash are precomputed before the backup rename.
    const oldProjectBasename = generateProjectId(projectPath);
    const dataDir = resolve(homedir(), ".agent-orchestrator");
    const oldDir = join(dataDir, `${oldStorageHash}-${oldProjectBasename}`);
    const runtimeDir = join(dataDir, `${runtimeHash}-${oldProjectBasename}`);

    if (oldStorageHash !== runtimeHash && existsSync(oldDir)) {
      try {
        if (!existsSync(runtimeDir)) {
          // Create symlink: runtime path → old data (so runtime finds existing data)
          symlinkSync(oldDir, runtimeDir);
        }

        // Count preserved sessions
        const sessionsDir = join(oldDir, "sessions");
        if (existsSync(sessionsDir)) {
          const entries = readdirSyncSafe(sessionsDir);
          const sessionFiles = entries.filter(
            (f) => !f.startsWith(".") && f !== "archive",
          );
          sessionCounts[projectId] = sessionFiles.length;
        }
      } catch (err) {
        warnings.push(`Failed to symlink storage for "${configKey}": ${err}`);
      }
    } else if (existsSync(oldDir)) {
      const sessionsDir = join(oldDir, "sessions");
      if (existsSync(sessionsDir)) {
        const entries = readdirSyncSafe(sessionsDir);
        const sessionFiles = entries.filter(
          (f) => !f.startsWith(".") && f !== "archive",
        );
        sessionCounts[projectId] = sessionFiles.length;
      }
    }
  }

  // Save global config
  saveGlobalConfig(globalConfig);
  const globalConfigPath = findGlobalConfigPath();

  return {
    migrated: true,
    globalConfigPath,
    registeredProjects,
    sessionCounts,
    warnings,
  };
}

/** Safe readdir that returns empty array on error */
function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir, "utf-8");
  } catch {
    return [];
  }
}

// =============================================================================
// EFFECTIVE CONFIG BUILDER
// =============================================================================

/**
 * Build an OrchestratorConfig from global config + local configs.
 *
 * For each project in the global config:
 * - If local config exists at project.path (hybrid mode): use local config for behavior
 * - Otherwise (global-only mode): use shadow in global config for behavior
 *
 * The result is an OrchestratorConfig that looks exactly like the old format
 * (with all projects populated), allowing existing code to work without changes.
 */
export function buildEffectiveConfig(
  globalConfig: GlobalConfig,
  globalConfigPath: string,
): import("./types.js").OrchestratorConfig {
  // Uses imports from top of file

  const projects: Record<string, import("./types.js").ProjectConfig> = {};

  for (const [projectId, entry] of Object.entries(globalConfig.projects)) {
    const projectPath = expandHome(entry.path);
    const mode = detectConfigMode(projectPath);

    let behaviorFields: Record<string, unknown>;

    if (mode === "hybrid") {
      // Load local config for behavior
      const localPath = findLocalConfigPath(projectPath);
      if (localPath) {
        try {
          const localConfig = loadLocalProjectConfig(localPath);
          behaviorFields = localConfig as Record<string, unknown>;
        } catch {
          // Invalid local config — fall back to shadow with warning
          behaviorFields = extractBehaviorFromShadow(entry);
        }
      } else {
        behaviorFields = extractBehaviorFromShadow(entry);
      }
    } else {
      // Global-only mode: shadow IS the config
      behaviorFields = extractBehaviorFromShadow(entry);
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
      tracker: behaviorFields["tracker"] as import("./types.js").TrackerConfig | undefined,
      scm: behaviorFields["scm"] as import("./types.js").SCMConfig | undefined,
      symlinks: behaviorFields["symlinks"] as string[] | undefined,
      postCreate: behaviorFields["postCreate"] as string[] | undefined,
      agentConfig: behaviorFields["agentConfig"] as import("./types.js").AgentSpecificConfig | undefined,
      orchestrator: behaviorFields["orchestrator"] as import("./types.js").RoleAgentConfig | undefined,
      worker: behaviorFields["worker"] as import("./types.js").RoleAgentConfig | undefined,
      reactions: behaviorFields["reactions"] as Record<string, Partial<import("./types.js").ReactionConfig>> | undefined,
      agentRules: behaviorFields["agentRules"] as string | undefined,
      agentRulesFile: behaviorFields["agentRulesFile"] as string | undefined,
      orchestratorRules: behaviorFields["orchestratorRules"] as string | undefined,
      orchestratorSessionStrategy: behaviorFields["orchestratorSessionStrategy"] as import("./types.js").ProjectConfig["orchestratorSessionStrategy"],
      opencodeIssueSessionStrategy: behaviorFields["opencodeIssueSessionStrategy"] as import("./types.js").ProjectConfig["opencodeIssueSessionStrategy"],
      decomposer: behaviorFields["decomposer"] as import("./types.js").ProjectConfig["decomposer"],
    };
  }

  return {
    configPath: globalConfigPath,
    globalConfigPath,
    port: globalConfig.port,
    terminalPort: globalConfig.terminalPort,
    directTerminalPort: globalConfig.directTerminalPort,
    readyThresholdMs: globalConfig.readyThresholdMs,
    defaults: globalConfig.defaults as import("./types.js").DefaultPlugins,
    projects,
    projectOrder: globalConfig.projectOrder,
    notifiers: globalConfig.notifiers as Record<string, import("./types.js").NotifierConfig>,
    notificationRouting: globalConfig.notificationRouting as Record<import("./types.js").EventPriority, string[]>,
    reactions: globalConfig.reactions as Record<string, import("./types.js").ReactionConfig>,
  };
}

/** Extract behavior fields from a shadow entry (everything that isn't identity/internal) */
function extractBehaviorFromShadow(entry: Record<string, unknown>): Record<string, unknown> {
  const behavior: Record<string, unknown> = {};
  const identityFields = new Set(["name", "path"]);

  for (const [key, value] of Object.entries(entry)) {
    if (!identityFields.has(key) && !key.startsWith("_")) {
      behavior[key] = value;
    }
  }
  return behavior;
}
