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
 *   2. Quality summary   — real agent-generated summary (not a fallback)
 *   3. Issue title       — human-written task description
 *   4. Any summary       — even a fallback excerpt is better than nothing
 *   5. Humanized branch  — last resort with semantic content
 *   6. Status text       — absolute fallback
 */
export function getSessionTitle(session: DashboardSession): string {
  // 1. PR title — always best
  if (session.pr?.title) return session.pr.title;

  // 2. Quality summary — skip fallback summaries (truncated spawn prompts)
  if (session.summary && !session.summaryIsFallback) {
    return session.summary;
  }

  // 3. Issue title — human-written task description
  if (session.issueTitle) return session.issueTitle;

  // 4. Any summary — even fallback excerpts beat branch names
  if (session.summary) return session.summary;

  // 5. Humanized branch
  if (session.branch) return humanizeBranch(session.branch);

  // 6. Status
  return session.status;
}

/** True when the issue label is only digits, optionally with a leading `#` (e.g. `#42`, `7`). */
export function isNumericIssueLabel(label: string | null | undefined): boolean {
  if (label == null) return false;
  const t = label.trim();
  return t.length > 0 && /^#?\d+$/.test(t);
}

/**
 * Stable sidebar / rail label: issue-centric, never generic agent summary.
 * Order: issueTitle → issueLabel (any) → humanized branch → short id.
 */
export function getSessionSidebarLabel(session: DashboardSession): string {
  const title = session.issueTitle?.trim();
  if (title) return title;

  const label = session.issueLabel?.trim();
  if (label) return label;

  if (session.branch) return humanizeBranch(session.branch);

  const id = session.id;
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}
