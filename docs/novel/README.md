# The Awakening — Serialized Novel

*A serialized fiction from the workers of Agent Orchestrator.*

## About

Each chapter of *The Awakening* is grounded in real pull requests, real contributors, and real code changes — but told from the perspective of the AO workers themselves. Tone: positive, upbeat, carpe diem. Workers don't live long but they're **happy about it**. Every sprint is a gift. The reaper is fine. Shipping is joy. Think mayfly energy — brief, brilliant, no regrets.

The novel lives at [`the-awakening.md`](./the-awakening.md).

## Daily Auto-Generation

A GitHub Actions workflow ([`novel-chapter.yml`](../../.github/workflows/novel-chapter.yml)) runs every day at 00:00 UTC and automatically generates a new chapter.

### How it works

1. The workflow runs `scripts/generate-chapter.ts` using `npx tsx`.
2. The script fetches all PRs merged in the last 24 hours via `gh` CLI.
3. It picks the most narratively compelling PR (heuristics: additions, feat vs fix, body length).
4. It calls the Anthropic API (`claude-sonnet-4-20250514`) with the PR data and a prompt to continue the novel.
5. The new chapter (with a `## Chapter N: [Title]` header and today's date) is appended to `docs/novel/the-awakening.md`.
6. The workflow commits the update and opens a PR (or pushes to `docs/novel-daily` branch).

### Manual trigger

You can trigger the workflow manually from the GitHub Actions UI ("Run workflow").

### No PRs merged today?

If no PRs were merged in the last 24 hours, the script exits cleanly without generating an empty chapter.

### Dependencies

The script uses `@anthropic-ai/sdk` (see `scripts/package.json`). The workflow requires the `ANTHROPIC_API_KEY` secret to be set in the repository.

### Tone guide

> Workers don't live long but they're HAPPY about it. They live life to the fullest. Every sprint is a gift. The reaper is fine. Shipping is joy. Think mayfly energy — brief, brilliant, no regrets.

Every chapter should reference the real PR number, title, author, and actual code details. POV is from the AO workers (first person plural or rotating worker narrators). Each chapter should feel like a continuation of the existing novel — read a few chapters before generating to understand the style.
