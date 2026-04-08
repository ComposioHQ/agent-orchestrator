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
const MAX_COMMITS = 10;
/** Maximum characters for the agent summary section. */
const MAX_SUMMARY_LENGTH = 500;

/**
 * Build a context summary from archived session metadata and git history.
 * Returns null if there is no meaningful context to inject.
 *
 * @param archivedRaw  Raw metadata from the archived session
 * @param workspacePath  Current workspace path (may already contain previous commits if branch is reused)
 * @param defaultBranch  Project's default branch name (e.g. "main", "master")
 */
export async function buildPreviousSessionContext(
  archivedRaw: Record<string, string>,
  workspacePath: string,
  defaultBranch = "main",
): Promise<string | null> {
  const status = archivedRaw["status"] ?? "unknown";
  const isDone = status === "done" || status === "cleanup";

  const parts: string[] = [];
  parts.push("## Previous Session Context");

  if (isDone) {
    parts.push(
      "A previous worker session completed normally on this same issue.",
    );
  } else {
    parts.push(
      `A previous worker session worked on this same issue and ended with status: ${status}.`,
    );
  }

  // Agent-generated summary (capped at MAX_SUMMARY_LENGTH)
  if (archivedRaw["summary"]) {
    let summary = archivedRaw["summary"];
    if (summary.length > MAX_SUMMARY_LENGTH) {
      summary = summary.slice(0, MAX_SUMMARY_LENGTH - 3) + "...";
    }
    parts.push(`\n### Agent Summary\n${summary}`);
  }

  // Git commits on the branch
  const branch = archivedRaw["branch"];
  if (branch && existsSync(workspacePath)) {
    try {
      // Check if the workspace is already on the same branch (branch was reused).
      // In that case the commits are already visible — just mention their existence.
      const { stdout: currentBranch } = await execFileAsync(
        "git",
        ["-C", workspacePath, "rev-parse", "--abbrev-ref", "HEAD"],
        { timeout: 5_000 },
      );
      const onSameBranch = currentBranch.trim() === branch;

      const { stdout } = await execFileAsync(
        "git",
        ["-C", workspacePath, "log", "--oneline", `--max-count=${MAX_COMMITS + 1}`, branch, "--not", `origin/${defaultBranch}`, "--"],
        { timeout: 10_000 },
      );
      if (stdout.trim()) {
        const allCommits = stdout.trim().split("\n");
        const hasMore = allCommits.length > MAX_COMMITS;
        if (onSameBranch) {
          // Gap 4: Commits are already in the working tree — don't list them redundantly
          const countLabel = hasMore ? `${MAX_COMMITS}+` : String(allCommits.length);
          parts.push(
            `\nThis branch has ${countLabel} existing commit(s) from a previous attempt. Review them with \`git log\`.`,
          );
        } else {
          const commits = allCommits.slice(0, MAX_COMMITS);
          parts.push(`\n### Commits Made\n${commits.map((c) => `- ${c}`).join("\n")}`);
          if (hasMore) {
            parts.push(`(more commits not shown)`);
          }
        }
      }
    } catch {
      /* best effort — git may fail if branch is gone */
    }
  }

  // PR info
  if (archivedRaw["pr"]) {
    if (isDone) {
      parts.push(
        `\nThe previous session opened PR ${archivedRaw["pr"]}. Check for review feedback and make any necessary changes.`,
      );
    } else {
      parts.push(
        `\nA PR was opened: ${archivedRaw["pr"]}. Check its status and review comments before continuing.`,
      );
    }
  }

  // Only return context if we have something meaningful beyond the header
  if (!archivedRaw["summary"] && !archivedRaw["pr"] && parts.length <= 2) {
    return null;
  }

  if (isDone) {
    parts.push(
      `\n### Instructions\nThe previous session completed. Check the PR for review comments and address any feedback. Do not redo work that is already done.`,
    );
  } else {
    parts.push(
      `\n### Instructions\nDo NOT start over from scratch. Review the previous work and continue from where it left off. If the previous approach had issues, learn from them and try a different approach.`,
    );
  }

  let result = parts.join("\n");
  if (result.length > MAX_CONTEXT_LENGTH) {
    result = result.slice(0, MAX_CONTEXT_LENGTH - 3) + "...";
  }
  return result;
}
