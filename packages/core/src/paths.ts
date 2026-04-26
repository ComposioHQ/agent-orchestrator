/**
 * Path utilities for storage-key-based directory structure.
 */

import { createHash } from "node:crypto";
import { dirname, basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { realpathSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";

/**
 * Generate a 12-character hash from a config directory path.
 *
 * The hash is derived from dirname(configPath), which equals the project root
 * directory when configPath is <project>/agent-orchestrator.yaml.
 *
 * Handles non-existent paths gracefully (e.g. synthesized paths in remote/
 * Docker mode where no local config file exists) by falling back to
 * resolve() when realpathSync fails.
 */
export function generateConfigHash(configPath: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(configPath);
  } catch {
    // File may not exist (remote mode, Docker, pre-creation) — use resolved path
    resolved = resolve(configPath);
  }
  const configDir = dirname(resolved);
  const hash = createHash("sha256").update(configDir).digest("hex");
  return hash.slice(0, 12);
}

/**
 * Generate project ID from project path (basename of the path).
 * Example: ~/repos/integrator → "integrator"
 */
export function generateProjectId(projectPath: string): string {
  return basename(projectPath);
}

/**
 * Generate session prefix from project ID using clean heuristics.
 *
 * Rules:
 * 1. ≤4 chars: use as-is (lowercase)
 * 2. CamelCase: extract uppercase letters (PyTorch → pt)
 * 3. kebab/snake case: use initials (agent-orchestrator → ao)
 * 4. Single word: first 3 chars (integrator → int)
 */
export function generateSessionPrefix(projectId: string): string {
  if (projectId.length <= 4) {
    return projectId.toLowerCase();
  }

  // CamelCase: extract uppercase letters
  const uppercase = projectId.match(/[A-Z]/g);
  if (uppercase && uppercase.length > 1) {
    return uppercase.join("").toLowerCase();
  }

  // kebab-case or snake_case: use initials
  if (projectId.includes("-") || projectId.includes("_")) {
    const separator = projectId.includes("-") ? "-" : "_";
    return projectId
      .split(separator)
      .map((word) => word[0])
      .join("")
      .toLowerCase();
  }

  // Single word: first 3 characters
  return projectId.slice(0, 3).toLowerCase();
}

/**
 * Get the project base directory for a storage key.
 * Format: ~/.agent-orchestrator/{storageKey}
 */
export function getProjectBaseDir(storageKey: string | undefined): string {
  return join(expandHome("~/.agent-orchestrator"), requireStorageKey(storageKey));
}

/**
 * Get the shared observability base directory for a config.
 * Format: ~/.agent-orchestrator/{hash}-observability
 */
export function getObservabilityBaseDir(configPath: string): string {
  const hash = generateConfigHash(configPath);
  return join(expandHome("~/.agent-orchestrator"), `${hash}-observability`);
}

/**
 * Get the sessions directory for a project.
 * Format: ~/.agent-orchestrator/{storageKey}/sessions
 */
export function getSessionsDir(storageKey: string | undefined): string {
  return join(getProjectBaseDir(storageKey), "sessions");
}

/**
 * Get the worktrees directory for a project.
 * Format: ~/.agent-orchestrator/{storageKey}/worktrees
 */
export function getWorktreesDir(storageKey: string | undefined): string {
  return join(getProjectBaseDir(storageKey), "worktrees");
}

/**
 * Get the feedback reports directory for a project.
 * Format: ~/.agent-orchestrator/{storageKey}/feedback-reports
 */
export function getFeedbackReportsDir(storageKey: string | undefined): string {
  return join(getProjectBaseDir(storageKey), "feedback-reports");
}

/**
 * Get the archive directory for a project.
 * Format: ~/.agent-orchestrator/{storageKey}/sessions/archive
 */
export function getArchiveDir(storageKey: string | undefined): string {
  return join(getSessionsDir(storageKey), "archive");
}

/**
 * Get the .origin file path for a project.
 * This file stores the config path for collision detection.
 */
export function getOriginFilePath(storageKey: string | undefined): string {
  return join(getProjectBaseDir(storageKey), ".origin");
}

/**
 * Generate user-facing session name.
 * Format: {prefix}-{num}
 * Example: "int-1", "ao-42"
 */
export function generateSessionName(prefix: string, num: number): string {
  return `${prefix}-${num}`;
}

/**
 * Generate tmux session name (globally unique).
 * Format: {storageKey}-{prefix}-{num}
 * Example: "a3b4c5d6e7f8-int-1"
 */
export function generateTmuxName(storageKey: string | undefined, prefix: string, num: number): string {
  return `${requireStorageKey(storageKey)}-${prefix}-${num}`;
}

/**
 * Parse a tmux session name to extract components.
 * Returns null if the name doesn't match the expected format.
 */
export function parseTmuxName(tmuxName: string): {
  hash: string;
  prefix: string;
  num: number;
} | null {
  const match = tmuxName.match(/^([a-f0-9]{12})-([a-zA-Z0-9_-]+)-(\d+)$/);
  if (!match) return null;

  return {
    hash: match[1],
    prefix: match[2],
    num: parseInt(match[3], 10),
  };
}

/**
 * Expand ~ to home directory.
 */
export function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

/** Get the base AO directory (~/.agent-orchestrator/) */
export function getAoBaseDir(): string {
  return expandHome("~/.agent-orchestrator");
}

/** Get the portfolio directory (~/.agent-orchestrator/portfolio/) */
export function getPortfolioDir(): string {
  return join(getAoBaseDir(), "portfolio");
}

/** Get the portfolio preferences file path */
export function getPreferencesPath(): string {
  return join(getPortfolioDir(), "preferences.json");
}

/** Get the portfolio registered projects file path */
export function getRegisteredPath(): string {
  return join(getPortfolioDir(), "registered.json");
}

/**
 * Validate and store the .origin file for a project.
 *
 * When the stored config path differs from the current one (e.g. after
 * migrating from a local config to the global hybrid config), the .origin
 * file is updated to the new path.  A true SHA-256 hash collision on 12 hex
 * chars (1 in 2^48) is astronomically unlikely and not worth blocking a
 * legitimate config migration.
 */
export function validateAndStoreOrigin(configPath: string, storageKey: string): void {
  const originPath = getOriginFilePath(storageKey);
  let resolvedConfigPath: string;
  try {
    resolvedConfigPath = realpathSync(configPath);
  } catch {
    resolvedConfigPath = resolve(configPath);
  }

  if (existsSync(originPath)) {
    const stored = readFileSync(originPath, "utf-8").trim();
    if (stored !== resolvedConfigPath) {
      // Config path changed (local → global migration). Update .origin.
      writeFileSync(originPath, resolvedConfigPath, "utf-8");
    }
  } else {
    // Create project base directory and .origin file
    const baseDir = getProjectBaseDir(storageKey);
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(originPath, resolvedConfigPath, "utf-8");
  }
}

export function requireStorageKey(storageKey: string | undefined): string {
  if (!storageKey) {
    throw new Error("storageKey is required");
  }
  return storageKey;
}
