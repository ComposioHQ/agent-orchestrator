## Status update — real-agent benchmark exposes a hidden bottleneck

**TL;DR:** AO-side polling is fully under control (B1 fix is doing its job). But a 5-real-agent run on `illegalcall/todo-app` exhausted the GraphQL bucket in 31 minutes — and AO accounted for almost none of it. **The agents themselves are the consumers**, and we have zero visibility into their `gh` calls.

### What we now have (good news)

Quiet-steady scaling curve, post-B1, single repo, placeholder sessions:

| Sessions | GraphQL pts/hr | % of budget | Poll cycle | ETag 304 rate |
|---------:|---------------:|------------:|-----------:|--------------:|
| 5  | 260   | 5%  | ~30s | 100% |
| 10 | 640   | 13% | ~30s | 100% |
| 20 | 680   | 14% | ~30s | 100% |
| 30 | 900   | 18% | 53s  | 100% |
| 40 | 1,140 | 23% | 58s  | 100% |
| 50 | ~1,400| 28% | 66s  | 100% |

Zero `graphql-batch` calls during steady state. B1 (304-as-error) fix and rateLimit instrumentation work as designed.

### Real-agent run (2026-04-18) — the catastrophe

5 Claude Code agents, real issues (#108–#112), CI active, 31 min run:

| Metric | Value |
|---|---|
| GraphQL: before | remaining=4938, used=62 |
| GraphQL: after  | **remaining=0, used=5006** |
| Consumed | 4944 points / 31 min ≈ 9572 pts/hr (**191% of budget**) |
| Core REST consumed | 11 (negligible) |
| PRs created | 4 of 5 (#113–#116); 1 session never opened a PR |
| Sessions reaching terminal state | 0 |

Quiet-steady at 5 sessions: 260 pts/hr. Real agents at 5 sessions: ~9572 pts/hr. **~37× more consumption per session.**

### Source attribution

AO's lifecycle worker only logged ~4 `GraphQL Batch Success` events during the window (≤10 GraphQL calls). The remaining ~4934 points were consumed by the agents themselves — `gh issue view`, `gh pr view`, `gh pr checks`, `gh api graphql`, etc.

The PATH wrapper at `~/.ao/bin/gh` is **metadata-only**: it intercepts `pr/create` and `pr/merge` for status updates, then `exec`s the real `gh` for everything else. Agent gh calls bypass `execGhObserved` entirely and are invisible.

### Updated capacity claim

The "50 sessions on a single PAT" target holds only for placeholder workloads. Real-world ceiling is bounded by **per-agent gh consumption**, not AO polling.

| Scenario | Practical ceiling on 1 PAT |
|---|---|
| Quiet-steady (placeholder sessions) | 50+ |
| Real Claude Code agents on a single repo | **~5 active** before throttling |

This isn't an AO bug — it's the cost of every agent independently calling the GitHub API. But it changes what we should optimize next.

### Plan update

- **B4 (poll cycle optimization)** — deprioritized. Optimizes a regime we can't reach until D shrinks per-agent cost.
- **Track D (NEW)** — agent-side gh consumption. Steps:
  - **D1:** Patch `~/.ao/bin/gh` to log every invocation to a JSONL trace. ~30 lines of bash, zero behavior change.
  - **D2:** Re-run the 5-real-agent benchmark locally with D1 active. Get a real per-call breakdown.
  - **D3:** Adil reruns the same benchmark on his machine for cross-verification (separate comment with steps).
  - **D4:** Categorize calls (which subcommands? duplicates? phase concentration?), then pick reduction strategy: wrapper-side cache, prompt guidance, per-agent PAT, GitHub App tokens, or push agents to the GitHub MCP server.
- **B5 (NEW)** — migrate remaining CLI/web callsites to `execGhObserved`. Mechanical, parallelizable with D.

Full notes: `experiments/DISCUSSION-NOTES.md` (Real-Agent Benchmark section), plan delta in `experiments/PLAN.md` (Track D).
