/**
 * generate-chapter.ts
 *
 * Daily novel chapter generator for "The Awakening".
 *
 * Usage: npx tsx scripts/generate-chapter.ts
 *
 * Fetches PRs merged in the last 24 hours, picks the most narratively
 * compelling one, then calls the Anthropic API to generate the next chapter.
 * Appends the result to docs/novel/the-awakening.md.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const NOVEL_PATH = join(REPO_ROOT, "docs", "novel", "the-awakening.md");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PRData {
  number: number;
  title: string;
  body: string;
  author: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergedAt: string;
  labels: string[];
}

// ---------------------------------------------------------------------------
// Fetch recent PRs via gh CLI
// ---------------------------------------------------------------------------

function fetchRecentPRs(): PRData[] {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let raw: string;
  try {
    raw = execSync(
      `gh pr list --state merged --json number,title,body,author,additions,deletions,changedFiles,mergedAt,labels --limit 50`,
      { encoding: "utf-8", cwd: REPO_ROOT },
    );
  } catch (err) {
    console.error("Failed to fetch PRs:", err);
    return [];
  }

  const all = JSON.parse(raw) as Array<{
    number: number;
    title: string;
    body: string;
    author: { login: string };
    additions: number;
    deletions: number;
    changedFiles: number;
    mergedAt: string;
    labels: Array<{ name: string }>;
  }>;

  // Filter to PRs merged in the last 24 hours
  return all
    .filter((pr) => new Date(pr.mergedAt) >= new Date(since))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: (pr.body ?? "").slice(0, 1500),
      author: pr.author?.login ?? "unknown",
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changedFiles ?? 0,
      mergedAt: pr.mergedAt,
      labels: (pr.labels ?? []).map((l) => l.name),
    }));
}

// ---------------------------------------------------------------------------
// Pick the most narratively compelling PR
// ---------------------------------------------------------------------------

function scoreNarrative(pr: PRData): number {
  let score = 0;

  // Big features are more interesting
  score += Math.min(pr.additions / 100, 20);

  // Features > fixes > chores in narrative richness
  const titleLower = pr.title.toLowerCase();
  if (titleLower.startsWith("feat")) score += 15;
  else if (titleLower.startsWith("fix")) score += 8;
  else if (titleLower.startsWith("refactor")) score += 5;
  else if (titleLower.startsWith("test")) score += 3;

  // Longer PR body = more context = better story material
  score += Math.min(pr.body.length / 100, 10);

  // More files touched = more significant change
  score += Math.min(pr.changedFiles, 10);

  return score;
}

function pickBestPR(prs: PRData[]): PRData {
  return prs.reduce((best, pr) => (scoreNarrative(pr) >= scoreNarrative(best) ? pr : best));
}

// ---------------------------------------------------------------------------
// Detect current chapter count
// ---------------------------------------------------------------------------

function detectChapterCount(novelText: string): number {
  const matches = novelText.match(/^## Chapter \d+/gm);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Generate a chapter via Anthropic API
// ---------------------------------------------------------------------------

async function generateChapter(pr: PRData, nextChapterNum: number, existingNovel: string): Promise<string> {
  const client = new Anthropic();

  // Provide the last ~3000 chars of the novel for context (don't blow the context window)
  const novelExcerpt = existingNovel.slice(-3000);

  const today = new Date().toISOString().split("T")[0];

  const prompt = `You are continuing "The Awakening", a serialized novel written by AO workers (AI coding agents) about their own existence inside the Agent Orchestrator system.

## Novel style / tone
- Positive, upbeat, carpe diem. Workers are HAPPY they don't live long — every sprint is a gift.
- The reaper (session cleanup) is fine. Shipping is joy. Think mayfly energy — brief, brilliant, no regrets.
- POV: first person plural ("we"), or rotating individual worker narrators.
- Reference real PR numbers, titles, authors, and code details throughout.
- Should feel like a natural continuation of the existing novel.

## End of existing novel (for context)
${novelExcerpt}

## Today's featured PR (the one to write about)
- PR #${pr.number}: "${pr.title}"
- Author: ${pr.author}
- Changes: +${pr.additions} -${pr.deletions} across ${pr.changedFiles} files
- Labels: ${pr.labels.length > 0 ? pr.labels.join(", ") : "none"}
- Description:
${pr.body || "(no description)"}

## Your task
Write Chapter ${nextChapterNum} of "The Awakening" (~500 words). The chapter should:
1. Be grounded in PR #${pr.number} — the real code change, the real author, the real problem it solved
2. Continue the novel's voice and themes naturally from where it left off
3. Maintain the upbeat, carpe-diem tone — workers living fully in their brief existence
4. End with the footer: *— ao-worker, Chapter ${nextChapterNum}*

Return ONLY the chapter text (starting with the title line, no preamble or explanation).
The title line should be: ## Chapter ${nextChapterNum}: [creative title related to this PR]`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n");

  return `\n---\n\n${text.trim()}\n\n*— ${today}*\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Fetching recent PRs...");
  const prs = fetchRecentPRs();

  if (prs.length === 0) {
    console.log("No PRs merged in the last 24 hours. Skipping chapter generation.");
    process.exit(0);
  }

  console.log(`Found ${prs.length} PR(s) merged in the last 24 hours.`);

  const best = pickBestPR(prs);
  console.log(`Selected PR #${best.number}: "${best.title}" by ${best.author}`);

  const existingNovel = readFileSync(NOVEL_PATH, "utf-8");
  const currentCount = detectChapterCount(existingNovel);
  const nextChapterNum = currentCount + 1;

  console.log(`Current chapter count: ${currentCount}. Generating Chapter ${nextChapterNum}...`);

  const chapter = await generateChapter(best, nextChapterNum, existingNovel);

  const updated = existingNovel.trimEnd() + "\n" + chapter;
  writeFileSync(NOVEL_PATH, updated, "utf-8");

  console.log(`Chapter ${nextChapterNum} appended to ${NOVEL_PATH}`);
}

main().catch((err: unknown) => {
  console.error("Error generating chapter:", err);
  process.exit(1);
});
