/**
 * Path utilities for hash-based directory structure.
 *
 * Architecture:
 * - Config location determines hash: sha256(dirname(configPath)).slice(0, 12)
 * - Each project gets directory: ~/.agent-orchestrator/{hash}-{projectId}/
 * - Sessions inside: sessions/{sessionName} (no hash prefix, already namespaced)
 * - Tmux names include hash for global uniqueness: {hash}-{prefix}-{num}
 */

import { createHash } from "node:crypto";
import { dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import { realpathSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import type { OrchestratorConfig } from "./types.js";

/**
 * Generate a 12-character hash from a config directory path.
 * Always resolves symlinks before hashing to ensure consistency.
 */
export function generateConfigHash(configPath: string): string {
  const resolved = realpathSync(configPath);
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
 * Generate instance ID combining hash and project ID.
 * Format: {hash}-{projectId}
 * Example: "a3b4c5d6e7f8-integrator"
 */
export function generateInstanceId(configPath: string, projectPath: string): string {
  const hash = generateConfigHash(configPath);
  const projectId = generateProjectId(projectPath);
  return `${hash}-${projectId}`;
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
 * Get the project base directory for a given config and project.
 * Format: ~/.agent-orchestrator/{hash}-{projectId}
 */
export function getProjectBaseDir(configPath: string, projectPath: string): string {
  const instanceId = generateInstanceId(configPath, projectPath);
  return join(expandHome("~/.agent-orchestrator"), instanceId);
}

/**
 * Get the sessions directory for a project.
 * Format: ~/.agent-orchestrator/{hash}-{projectId}/sessions
 */
export function getSessionsDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "sessions");
}

/**
 * Get the worktrees directory for a project.
 * Format: ~/.agent-orchestrator/{hash}-{projectId}/worktrees
 */
export function getWorktreesDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "worktrees");
}

/**
 * Get the archive directory for a project.
 * Format: ~/.agent-orchestrator/{hash}-{projectId}/archive
 */
export function getArchiveDir(configPath: string, projectPath: string): string {
  return join(getSessionsDir(configPath, projectPath), "archive");
}

/**
 * Get the logs directory for a project.
 * Format: ~/.agent-orchestrator/{hash}-{projectId}/logs
 */
export function getLogsDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "logs");
}

/**
 * Get the retrospectives directory for a project.
 * Format: ~/.agent-orchestrator/{hash}-{projectId}/retrospectives
 */
export function getRetrospectivesDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "retrospectives");
}

/**
 * Resolve the log directory for the first configured project.
 * Returns null if no projects are configured.
 */
export function resolveProjectLogDir(config: OrchestratorConfig): string | null {
  const projectId = Object.keys(config.projects)[0];
  if (!projectId) return null;
  return getLogsDir(config.configPath, config.projects[projectId].path);
}

/**
 * Resolve the retrospectives directory for the first configured project.
 * Returns null if no projects are configured.
 */
export function resolveProjectRetroDir(config: OrchestratorConfig): string | null {
  const projectId = Object.keys(config.projects)[0];
  if (!projectId) return null;
  return getRetrospectivesDir(config.configPath, config.projects[projectId].path);
}

/**
 * Get the .origin file path for a project.
 * This file stores the config path for collision detection.
 */
export function getOriginFilePath(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), ".origin");
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
 * Format: {hash}-{prefix}-{num}
 * Example: "a3b4c5d6e7f8-int-1"
 */
export function generateTmuxName(configPath: string, prefix: string, num: number): string {
  const hash = generateConfigHash(configPath);
  return `${hash}-${prefix}-${num}`;
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

/**
 * Validate and store the .origin file for a project.
 * Throws if a hash collision is detected (different config, same hash).
 */
export function validateAndStoreOrigin(configPath: string, projectPath: string): void {
  const originPath = getOriginFilePath(configPath, projectPath);
  const resolvedConfigPath = realpathSync(configPath);

  if (existsSync(originPath)) {
    const stored = readFileSync(originPath, "utf-8").trim();
    if (stored !== resolvedConfigPath) {
      throw new Error(
        `Hash collision detected!\n` +
          `Directory: ${getProjectBaseDir(configPath, projectPath)}\n` +
          `Expected config: ${resolvedConfigPath}\n` +
          `Actual config: ${stored}\n` +
          `This is a rare hash collision. Please move one of the configs to a different directory.`,
      );
    }
  } else {
    // Create project base directory and .origin file
    const baseDir = getProjectBaseDir(configPath, projectPath);
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(originPath, resolvedConfigPath, "utf-8");
  }
}
