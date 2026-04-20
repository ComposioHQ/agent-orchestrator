/**
 * Format automated (bot) review comments into a detailed message for the agent.
 *
 * Design context (#895): the previous generic "fix the bot's issues" message
 * forced the agent to rediscover comments via `gh api .../pulls/PR/comments`
 * (first page only), which silently drops newly-posted comments that land on
 * later pages. This formatter lists every already-fetched comment and embeds
 * explicit correct-API guidance so the agent never has to guess.
 */

import type { AutomatedComment, PRInfo } from "./types.js";

const EXCERPT_MAX = 160;

/** Extract a single trimmed line and cap it at EXCERPT_MAX, appending "…" when truncated. */
function excerpt(body: string): string {
  const first = body.split("\n", 1)[0].trim();
  return first.length > EXCERPT_MAX ? `${first.slice(0, EXCERPT_MAX)}…` : first;
}

export function formatAutomatedCommentsMessage(
  comments: AutomatedComment[],
  pr?: Pick<PRInfo, "owner" | "repo" | "number">,
): string {
  // repoSlug interpolates real identifiers when we know them; falls back to
  // placeholders for the config.ts default path that has no PR context.
  const repoSlug = pr ? `${pr.owner}/${pr.repo}` : "OWNER/REPO";
  const prRef = pr ? String(pr.number) : "PR";

  const lines = [
    "Automated review comments found on your PR. Address each of the following issues:",
    "",
  ];
  for (const c of comments) {
    const loc = c.path ? ` \`${c.path}${c.line ? `:${c.line}` : ""}\`` : "";
    lines.push(`- **[${c.severity}] ${c.botName}**${loc}: ${excerpt(c.body)}`);
    lines.push(`  ${c.url}`);
  }
  lines.push(
    "",
    "Fix each issue, push your changes, and reply to the inline comment to resolve it.",
    "",
    "To verify you have covered the latest bot review (avoid relying on `gh pr checks`, which can be stale, or on `gh api repos/" +
      repoSlug +
      "/pulls/" +
      prRef +
      "/comments` alone, which can be paginated):",
    "",
    `  1. \`gh api repos/${repoSlug}/pulls/${prRef}/reviews --paginate\` — pick the most recent review whose \`user.login\` is a bot (e.g. \`cursor[bot]\`), by \`submitted_at\`.`,
    `  2. \`gh api repos/${repoSlug}/pulls/${prRef}/reviews/REVIEW_ID/comments\` — the inline comments for that specific review.`,
    `  3. \`gh api repos/${repoSlug}/pulls/${prRef}/comments --paginate\` — full comment list (paginate!); a top-level comment is addressed only when some later comment has \`in_reply_to_id\` equal to its \`id\`.`,
  );
  return lines.join("\n");
}
