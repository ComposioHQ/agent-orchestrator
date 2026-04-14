/**
 * Pure formatting utilities safe for both server and client components.
 * No side effects, no external dependencies.
 */

import type { DashboardSession } from "./types.js";

/**
 * Humanize a git branch name into a readable title.
 * e.g., "feat/infer-project-id" → "Infer Project ID"
 *       "fix/broken-auth-flow"  → "Broken Auth Flow"
 *       "session/ao-52"         → "ao-52"
 */
export function humanizeBranch(branch: string): string {
  // Remove common prefixes
  const withoutPrefix = branch.replace(
    /^(?:feat|fix|chore|refactor|docs|test|ci|session|release|hotfix|feature|bugfix|build|wip|improvement)\//,
    "",
  );
  // Replace hyphens and underscores with spaces, then title-case each word
  return withoutPrefix
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Compute the best display title for a session card.
 *
 * Fallback chain (ordered by signal quality):
 *   1. PR title         — human-visible deliverable name
 *   2. Issue title       — human-written task description
 *   3. User prompt       — freeform spawn instructions (prompt-only sessions)
 *   4. Humanized branch  — stable task identifier when no explicit title exists
 *   5. Pinned summary    — first quality summary, stable across agent updates
 *   6. Quality summary   — live summary, but can drift as the session evolves
 *   7. Any summary       — even a fallback excerpt is better than nothing
 *   8. Status text       — absolute fallback
 */
export function getSessionTitle(session: DashboardSession): string {
  // 1. PR title — always best
  if (session.pr?.title) return session.pr.title;

  // 2. Issue title — human-written task description
  if (session.issueTitle) return session.issueTitle;

  // 3. User prompt — freeform spawn instructions (prompt-only sessions have no issue)
  if (session.userPrompt) return session.userPrompt;

  // 4. Humanized branch — stable semantic fallback
  if (session.branch) return humanizeBranch(session.branch);

  // 5. Pinned summary — first quality summary, stable across agent updates
  const pinnedSummary = session.metadata["pinnedSummary"];
  if (pinnedSummary) return pinnedSummary;

  // 6. Quality summary — skip fallback summaries (truncated spawn prompts)
  if (session.summary && !session.summaryIsFallback) {
    return session.summary;
  }

  // 7. Any summary — even fallback excerpts beat raw status text
  if (session.summary) return session.summary;

  // 8. Status
  return session.status;
}
