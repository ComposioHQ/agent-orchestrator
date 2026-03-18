/**
 * Shared git helpers for CLI commands.
 * Avoids duplicating detection logic across init.ts and add-project.ts.
 */

import { git, gh } from "./shell.js";

/**
 * Detect the default branch for a repository using three methods:
 *   1. git symbolic-ref (most reliable — reads what origin/HEAD points to)
 *   2. GitHub API via gh CLI (works when symbolic-ref isn't set)
 *   3. Check which common branch name exists in remote refs
 *
 * Falls back to "main" if all methods fail.
 */
export async function detectDefaultBranch(
  workingDir: string,
  ownerRepo: string | null,
): Promise<string> {
  // Method 1: symbolic-ref
  const symbolicRef = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], workingDir);
  if (symbolicRef) {
    const match = symbolicRef.match(/refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  }

  // Method 2: GitHub API
  if (ownerRepo) {
    const ghResult = await gh([
      "repo",
      "view",
      ownerRepo,
      "--json",
      "defaultBranchRef",
      "-q",
      ".defaultBranchRef.name",
    ]);
    if (ghResult) return ghResult;
  }

  // Method 3: Check common branch names
  const commonBranches = ["main", "master", "next", "develop"];
  for (const branch of commonBranches) {
    const exists = await git(["rev-parse", "--verify", `origin/${branch}`], workingDir);
    if (exists) return branch;
  }

  return "main";
}
