/**
 * Publish guards — safety checks before publishing an artifact.
 */

import { basename, resolve } from "node:path";

const BLOCKED_PATTERNS = [
  ".env",
  ".secret",
  "credentials",
  "id_rsa",
  "id_ed25519",
  "node_modules/",
  ".git/",
  ".npmrc",
  ".pypirc",
];

/**
 * Validate that a file is safe to publish as an artifact.
 * Throws if the file matches a security filter or is outside the worktree.
 */
export function validatePublish(filePath: string, worktreePath: string): void {
  const name = basename(filePath);
  const resolved = resolve(filePath);

  // Block sensitive files
  for (const pattern of BLOCKED_PATTERNS) {
    if (name.includes(pattern) || resolved.includes(pattern)) {
      throw new Error(`Blocked: ${filePath} matches security filter (${pattern})`);
    }
  }

  // Block path traversal — file must be within the worktree
  const resolvedWorktree = resolve(worktreePath);
  if (!resolved.startsWith(resolvedWorktree + "/") && resolved !== resolvedWorktree) {
    throw new Error(`Blocked: path ${filePath} is outside worktree ${worktreePath}`);
  }
}
