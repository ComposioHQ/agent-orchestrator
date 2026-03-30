/**
 * Session Context Builder — extracts context from a previous session's archived
 * metadata and git history for injection into a new worker's prompt.
 *
 * Used when native agent resume isn't available (agent doesn't support it,
 * session files are corrupted, or agent was switched between sessions).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PreviousSessionContext {
  /** The session ID this context was built from */
  sourceSessionId: string;
  /** Summary from the previous session's agent (if available) */
  summary: string | null;
  /** Status the previous session ended in */
  previousStatus: string | null;
  /** PR URL if one was created */
  prUrl: string | null;
  /** Branch the previous session was working on */
  branch: string | null;
  /** Git log of commits on the branch (if available) */
  recentCommits: string | null;
}

/**
 * Build context from a previous session's archived metadata and git history.
 * Returns null if no useful context can be extracted.
 */
export async function buildPreviousSessionContext(
  sourceSessionId: string,
  archivedMetadata: Record<string, string>,
  projectPath: string,
  defaultBranch: string,
): Promise<PreviousSessionContext | null> {
  const summary = archivedMetadata["summary"] || null;
  const previousStatus = archivedMetadata["status"] || null;
  const prUrl = archivedMetadata["pr"] || null;
  const branch = archivedMetadata["branch"] || null;

  // Try to get recent commits from the branch
  let recentCommits: string | null = null;
  if (branch) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", `${defaultBranch}..${branch}`, "--oneline", "--no-decorate", "-20"],
        { cwd: projectPath, timeout: 5_000 },
      );
      const trimmed = stdout.trim();
      if (trimmed) {
        recentCommits = trimmed;
      }
    } catch {
      // Branch may not exist locally or other git error — skip
    }
  }

  // Only return context if we have at least something useful
  if (!summary && !prUrl && !recentCommits) {
    return null;
  }

  return {
    sourceSessionId,
    summary,
    previousStatus,
    prUrl,
    branch,
    recentCommits,
  };
}

/**
 * Format previous session context into a prompt section that can be
 * prepended to a new worker's prompt.
 */
export function formatPreviousSessionContext(context: PreviousSessionContext): string {
  const lines: string[] = [];

  lines.push("## Previous Session Context");
  lines.push(
    `A previous worker session (\`${context.sourceSessionId}\`) worked on this same issue before. Here is what it accomplished:`,
  );

  if (context.summary) {
    lines.push(`\n### Agent Summary\n${context.summary}`);
  }

  if (context.previousStatus) {
    lines.push(`\n### Previous Status: \`${context.previousStatus}\``);
  }

  if (context.prUrl) {
    lines.push(`\n### Pull Request\nA PR was already created: ${context.prUrl}`);
    lines.push(
      "Review the existing PR and continue from where it left off rather than creating a new one.",
    );
  }

  if (context.branch) {
    lines.push(`\n### Branch: \`${context.branch}\``);
  }

  if (context.recentCommits) {
    lines.push(`\n### Commits from previous session:\n\`\`\`\n${context.recentCommits}\n\`\`\``);
  }

  lines.push(
    "\n**Important:** Continue from where the previous session left off. Do not redo work that is already committed. Review the existing code changes and git history before making new changes.",
  );

  return lines.join("\n");
}
