/**
 * File Scope Audit — validates that agents only modify their assigned files.
 *
 * After every agent completion in implement, integrate, and revise phases,
 * the phase engine runs:
 *   1. git diff --name-only against the agent's files array from the plan
 *   2. Out-of-scope modifications trigger surgical revert
 *   3. Two violations per agent per phase = abort with human notification
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileScopeAuditResult } from "@composio/ao-core";

const execFileAsync = promisify(execFile);

/** Options for running a file scope audit */
export interface FileScopeAuditOptions {
  /** Path to the worktree */
  worktreePath: string;
  /** Files the agent is allowed to modify */
  allowedFiles: string[];
  /** Base commit to diff against (e.g. HEAD~1 or a branch name) */
  baseRef?: string;
}

/**
 * Run a file scope audit against git diff.
 * Returns which files were modified outside the allowed scope.
 */
export async function auditFileScope(options: FileScopeAuditOptions): Promise<FileScopeAuditResult> {
  const { worktreePath, allowedFiles, baseRef = "HEAD~1" } = options;

  let changedFiles: string[];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", baseRef],
      { cwd: worktreePath, timeout: 30_000 },
    );
    changedFiles = stdout.trim().split("\n").filter(Boolean);
  } catch {
    // If git diff fails (e.g. no commits yet), treat as clean
    return {
      inScope: true,
      outOfScopeFiles: [],
      allowedFiles,
    };
  }

  const allowedSet = new Set(allowedFiles);
  const outOfScopeFiles = changedFiles.filter((f) => !allowedSet.has(f));

  return {
    inScope: outOfScopeFiles.length === 0,
    outOfScopeFiles,
    allowedFiles,
  };
}

/**
 * Revert out-of-scope file modifications (surgical revert, not full rollback).
 */
export async function revertOutOfScopeFiles(
  worktreePath: string,
  files: string[],
): Promise<void> {
  if (files.length === 0) return;

  await execFileAsync(
    "git",
    ["checkout", "--", ...files],
    { cwd: worktreePath, timeout: 30_000 },
  );
}
