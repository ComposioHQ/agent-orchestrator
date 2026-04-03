import { z } from "zod";
import { parse as parseTOML } from "smol-toml";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";

// =============================================================================
// ZOD SCHEMAS — matching CONFIG-SPEC.md
// =============================================================================

export const PlannerConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  model: z.string().default("claude-sonnet-4-20250514"),
  thinking_effort: z.enum(["low", "medium", "high"]).default("high"),
  cli: z.string().default("claude"),
  max_rounds: z.number().int().min(1).max(10).default(3),
});

export const WorkerOverrideSchema = z
  .object({
    cli: z.string().optional(),
  })
  .passthrough();

export const WorkersConfigSchema = z.object({
  cli: z.string().default("claude"),
  timeout_minutes: z.number().positive().default(30),
  max_parallel: z.number().int().min(1).max(32).default(4),
  overrides: z.record(WorkerOverrideSchema).default({}),
});

export const ContextConfigSchema = z.object({
  gather_tree: z.boolean().default(true),
  gather_configs: z.boolean().default(true),
  gather_readme: z.boolean().default(true),
  gather_claude_md: z.boolean().default(true),
  gather_git_log: z.boolean().default(true),
  git_log_count: z.number().int().positive().default(20),
  max_tree_depth: z.number().int().min(1).max(10).default(3),
  exclude_patterns: z
    .array(z.string())
    .default([
      "node_modules",
      ".git",
      "dist",
      "build",
      "__pycache__",
      ".venv",
      "venv",
    ]),
});

export const GitConfigSchema = z.object({
  worktree_enabled: z.boolean().default(true),
  branch_prefix: z.string().default("agentpyre/"),
  auto_pr: z.boolean().default(false),
});

export const OrchestratorConfigSchema = z.object({
  planner: PlannerConfigSchema.default({}),
  workers: WorkersConfigSchema.default({}),
  context: ContextConfigSchema.default({}),
  git: GitConfigSchema.default({}),
});

export type OrchestratorTomlConfig = z.infer<typeof OrchestratorConfigSchema>;

// =============================================================================
// CONFIG DISCOVERY
// =============================================================================

const PROJECT_CONFIG_FILENAME = ".agentpyre.toml";
const USER_CONFIG_DIR = ".agentpyre";
const USER_CONFIG_FILENAME = "config.toml";

function getUserConfigPath(): string {
  return join(homedir(), USER_CONFIG_DIR, USER_CONFIG_FILENAME);
}

/**
 * Walk up directory tree looking for .agentpyre.toml.
 * Falls back to ~/.agentpyre/config.toml.
 * Returns null if neither found.
 */
export function findConfigFile(startDir?: string): string | null {
  let dir = resolve(startDir ?? process.cwd());
  const root = resolve("/");

  while (dir !== root) {
    const candidate = join(dir, PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Check root directory too
  const rootCandidate = join(root, PROJECT_CONFIG_FILENAME);
  if (existsSync(rootCandidate)) return rootCandidate;

  // Fallback to user config
  const userConfig = getUserConfigPath();
  if (existsSync(userConfig)) return userConfig;

  return null;
}

/**
 * Parse a TOML file and return raw object.
 * Throws with file path context on parse errors.
 */
export function loadConfigFile(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, "utf-8");
  try {
    return parseTOML(content) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse TOML config at ${filePath}: ${msg}`, {
      cause: err,
    });
  }
}

// =============================================================================
// DEEP MERGE
// =============================================================================

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Deep-merge source into target. Arrays are replaced, not concatenated.
 * Returns a new object (does not mutate inputs).
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (isPlainObject(result[key]) && isPlainObject(source[key])) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Returns config with all defaults applied. */
export function getDefaultConfig(): OrchestratorTomlConfig {
  return OrchestratorConfigSchema.parse({});
}

/**
 * Load config with layered precedence:
 *   defaults < ~/.agentpyre/config.toml < .agentpyre.toml < overrides (CLI flags)
 */
export function loadConfig(
  overrides?: Partial<OrchestratorTomlConfig>,
  startDir?: string,
): OrchestratorTomlConfig {
  let merged: Record<string, unknown> = {};

  // Layer 1: user-level config (~/.agentpyre/config.toml)
  const userConfigPath = getUserConfigPath();
  if (existsSync(userConfigPath)) {
    merged = deepMerge(merged, loadConfigFile(userConfigPath));
  }

  // Layer 2: project-level config (.agentpyre.toml found via directory walk)
  const projectConfig = findProjectConfig(startDir);
  if (projectConfig) {
    merged = deepMerge(merged, loadConfigFile(projectConfig));
  }

  // Layer 3: CLI flag overrides
  if (overrides) {
    merged = deepMerge(merged, overrides as Record<string, unknown>);
  }

  // Validate and fill defaults via Zod
  return OrchestratorConfigSchema.parse(merged);
}

/**
 * Find project-level config only (not user-level).
 * Walks up from startDir looking for .agentpyre.toml.
 */
function findProjectConfig(startDir?: string): string | null {
  let dir = resolve(startDir ?? process.cwd());
  const root = resolve("/");

  while (dir !== root) {
    const candidate = join(dir, PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}
