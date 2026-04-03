/**
 * Build context about a previous session for injection into a new agent's prompt.
 *
 * When native resume isn't possible (agent doesn't support getRestoreCommand or
 * it returned null), this provides the new agent with awareness of what the
 * previous worker accomplished.
 */

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

/** Maximum characters for the context block to avoid oversized prompts. */
const MAX_CONTEXT_LENGTH = 4000;
/** Maximum number of git commits to include. */
const MAX_COMMITS = 20;

/**
 * Build a context summary from archived session metadata and git history.
 * Returns null if there is no meaningful context to inject.
 */
export async function buildPreviousSessionContext(
  archivedRaw: Record<string, string>,
  workspacePath: string,
): Promise<string | null> {
  const parts: string[] = [];
  parts.push("## Previous Session Context");
  parts.push(
    `A previous worker session worked on this same issue and ended with status: ${archivedRaw["status"] ?? "unknown"}.`,
  );

  // Agent-generated summary
  if (archivedRaw["summary"]) {
    parts.push(`\n### Agent Summary\n${archivedRaw["summary"]}`);
  }

  // Git commits on the branch
  const branch = archivedRaw["branch"];
  if (branch && existsSync(workspacePath)) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", workspacePath, "log", "--oneline", branch, "--not", "origin/main", "--"],
        { timeout: 10_000 },
      );
      if (stdout.trim()) {
        const commits = stdout.trim().split("\n").slice(0, MAX_COMMITS);
        parts.push(`\n### Commits Made\n${commits.map((c) => `- ${c}`).join("\n")}`);
      }
    } catch {
      /* best effort — git may fail if branch is gone */
    }
  }

  // PR info
  if (archivedRaw["pr"]) {
    parts.push(
      `\nA PR was opened: ${archivedRaw["pr"]}. Check its status and review comments before continuing.`,
    );
  }

  // Only return context if we have something meaningful beyond the header
  if (!archivedRaw["summary"] && !archivedRaw["pr"] && parts.length <= 2) {
    return null;
  }

  parts.push(
    `\n### Instructions\nDo NOT start over from scratch. Review the previous work and continue from where it left off. If the previous approach had issues, learn from them and try a different approach.`,
  );

  let result = parts.join("\n");
  if (result.length > MAX_CONTEXT_LENGTH) {
    result = result.slice(0, MAX_CONTEXT_LENGTH - 3) + "...";
  }
  return result;
}
