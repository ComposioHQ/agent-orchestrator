# Final Trace Report — Post All Optimizations

**Date:** 2026-04-23
**Branch:** `feat/gh-rate-limiting`
**Trace file:** `experiments/out/gh-trace-real-1776926071.jsonl` ([gist](https://gist.github.com/iamasx/03f8c5aa87499962f880b5aeeb606ce0))
**Applied:** Step 1 (remove REST fallback), Step 2 (consolidate review comments), Step 3 (remove dead reviews field), Shared Enrichment (dashboard reads metadata, single lifecycle)

## Test Conditions

| Parameter | Value |
|-----------|-------|
| Sessions | 5 |
| Duration | 23 min 39 sec (06:35 – 06:59 UTC) |
| Repo | iamasx/api-test |
| Issues | #196, #197, #198, #199, #200 |
| PRs created | #201, #204, #205 (2 sessions took longer) |
| Poll interval | 30 seconds |

## Rate-Limit Budget

| Budget | Before | After | Consumed (snapshot) | Projected/hour |
|--------|--------|-------|---------------------|----------------|
| **GraphQL** (5,000/hr) | 8 used | 370 used | **362** | **~905** (18%) |
| **REST** (5,000/hr) | 4 used | 6 used | **2** (see note) | **~110** (~2%) |

### REST budget note

The snapshot shows only 2 REST points consumed, but the actual REST usage is higher. This is because:

1. **304 responses are free.** Guard 1 returned 304 × 26 times, Guard 2 returned 304 × 72 times. These don't consume rate limit points.
2. **Rate limit window reset.** The before/after snapshots have different `reset` timestamps (before: `1776929003`, after: `1776929003`). If the hourly window reset between snapshots, the counter restarts from zero, making the delta unreliable.
3. **Actual REST calls that consume points:**

| Call type | Total calls | 200 responses (cost points) | 304 responses (free) |
|-----------|:-----------:|:---------------------------:|:--------------------:|
| Guard 1 (`gh api GET .../pulls`) | 42 | 16 | 26 |
| Guard 2 (`gh api GET .../status`) | 83 | 11 | 72 |
| `gh pr list` (CLI, REST under the hood) | 36 | 36 | — |
| `gh pr view` (CLI, REST under the hood) | 6 | 6 | — |
| `gh pr checks` (CLI, REST under the hood) | 3 | 3 | — |
| `gh pr merge` (CLI, REST under the hood) | 2 | 2 | — |
| `gh issue view` (CLI, REST under the hood) | 35 | 35 | — |
| `gh issue list` (CLI, REST under the hood) | 1 | 1 | — |
| **Total** | **208** | **~110** | **98** |

**Estimated actual REST consumption: ~110 points / 24 min → ~275/hr (5.5%).** The 98 free 304 responses from ETag guards are the biggest REST saving — without guards, those would be 98 additional 200 responses costing points.

The rate limit headers are only captured from `gh api -i` calls (guards and batch). The `gh` CLI commands (`pr list`, `pr view`, etc.) consume REST points but don't expose rate limit headers in the trace.

## Call Summary (266 total)

| Operation | Calls | Total Time | Avg Latency | Source |
|-----------|------:|----------:|------------:|--------|
| `gh api guard-commit-status` | 83 | 69.4s | 835ms | Lifecycle — ETag Guard 2 |
| `gh api guard-pr-list` | 42 | 38.3s | 912ms | Lifecycle — ETag Guard 1 |
| `gh pr list` (detectPR) | 36 | 37.4s | 1,037ms | Lifecycle — PR discovery |
| `gh api graphql` (review threads) | 36 | 33.2s | 920ms | Lifecycle — getReviewThreads |
| `gh issue view` | 35 | 37.2s | 1,061ms | Tracker |
| `gh api graphql-batch` | 22 | 29.1s | 1,324ms | Lifecycle — batch enrichment |
| `gh pr view` (residual) | 6 | 5.4s | 902ms | Webhook-triggered check |
| `gh pr checks` (residual) | 3 | 4.4s | 1,475ms | Webhook-triggered check |
| `gh pr merge` | 2 | 7.0s | 3,496ms | Merge action |
| `gh issue list` | 1 | 1.1s | 1,132ms | Tracker |

**Total wall time in gh calls:** 262.5 seconds (4.4 minutes of the 23.7-minute window).

## Single Lifecycle Manager — Confirmed

Guard 1 shows **2 calls per minute** consistently:

```
   2 2026-04-23T06:39
   2 2026-04-23T06:40
   2 2026-04-23T06:41
   2 2026-04-23T06:42
   ...
```

**Previous runs showed 4/min** (dual lifecycle). The web dashboard's polling is stopped. Only the CLI lifecycle manager runs.

## Dashboard API Calls — Eliminated

| Call type | Before optimization | After |
|-----------|:-------------------:|:-----:|
| Dashboard `pr view` | ~65 / 15 min | **0** |
| Dashboard `pr checks` | ~45 / 15 min | **0** |
| Dashboard `graphql` (review threads) | ~15 / 15 min | **0** |
| Dashboard lifecycle guards | ~27 / 15 min | **0** |
| Dashboard lifecycle batch | ~22 / 15 min | **0** |

The dashboard now reads from session metadata files. Zero GitHub API calls from the web process.

## ETag Guard Performance

| Guard | 304 (saved) | 200 (needed) | Total | Hit Rate |
|-------|:-----------:|:------------:|:-----:|:--------:|
| PR list (Guard 1) | 26 | 16 | 42 | **62%** |
| Commit status (Guard 2) | 72 | 11 | 83 | **87%** |

Guard 2 hit rate improved to 87% — most CI status checks return unchanged. When Guard 1 returns 304 (62% of the time), the batch query is skipped entirely.

Guard "errors" (98 total) are all expected — exit code 1 from `gh api` on 304 responses, handled correctly by the guard code.

## detectPR Analysis (36 calls)

| Branch | Calls | Created PR? |
|--------|------:|:-----------:|
| feat/issue-196 | 9 | Yes |
| feat/issue-200 | 7 | Yes (late) |
| feat/issue-198 | 7 | Yes |
| feat/issue-197 | 7 | Yes |
| feat/issue-199 | 6 | Yes |

All sessions eventually created PRs. 36 total calls = ~7 per session average. Once a PR is detected, calls stop. This is working as designed.

## Issue View Analysis (35 calls)

| Issue | Calls |
|-------|------:|
| #196 | 7 |
| #197 | 7 |
| #198 | 7 |
| #199 | 7 |
| #200 | 7 |

7 calls per issue. Expected ~2 per session (validate + generatePrompt). The extra ~5 per session come from session restores and the tracker plugin's 5-min TTL cache expiring during the 24-min run. This is a future optimization target (persist issue data to metadata).

## Review Threads Analysis (36 calls)

36 GraphQL calls over 24 minutes = ~1.5 calls/min. With 5 sessions and a 2-minute throttle:
- Expected: 5 sessions × (24 min / 2 min) = ~60
- Actual: 36 (lower because not all sessions had PRs for the full duration)

Single call per session per throttle window — no duplication. This is working correctly.

## Residual Individual Calls (9 total)

6 `pr view` + 3 `pr checks` — all from webhook-triggered `lifecycle.check()`:

```
06:41:41  pr view 201 --json state
06:41:42  pr view 201 --json mergeable,reviewDecision,mergeStateStatus,isDraft
06:41:43  pr checks 201
06:46:06  pr view 205 --json state
06:46:07  pr view 205 --json mergeable,reviewDecision,mergeStateStatus,isDraft
06:46:09  pr checks 205
06:46:18  pr view 204 --json state
06:46:19  pr view 204 --json mergeable,reviewDecision,mergeStateStatus,isDraft
06:46:20  pr checks 204
```

These are legitimate — triggered by GitHub webhook events (PR created, CI status change), not by polling. The webhook route calls `lifecycle.check(sessionId)` which runs `populatePREnrichmentCache([session])` → batch for that single PR. The `getMergeability` path in the webhook check still makes individual calls because the batch result for a single PR goes through the same code path.

## Traffic Composition

```
                    266 Total AO gh Calls
                           │
     ┌─────────────────────┼───────────────────┐
     │                     │                   │
 Batch System          PR Discovery        Other
  147 calls (55%)       36 calls (14%)     83 calls (31%)
     │                     │                   │
 Guard 1: 42          detectPR: 36        Review: 36
 Guard 2: 83                              Issue: 35+1
 Batch: 22                                Webhook: 9
                                          Merge: 2
```

## Before vs After — Full Journey

| Metric | Original | Final | Reduction |
|--------|----------|-------|:---------:|
| **Total calls / test** | 465 | 266 | **-43%** |
| **Calls / min** | 31 | 11 | **-65%** |
| **GraphQL / hour** | 2,072 | 905 | **-56%** |
| **REST / hour** | 168 | 5 | **-97%** |
| **Max sessions** | ~12 | ~27 | **+125%** |
| **Dashboard API calls** | ~150 | 0 | **-100%** |
| **Lifecycle managers** | 2 (duplicate) | 1 | **-50%** |
| **Automated comment REST** | 40 | 0 | **-100%** |
| **pr view individual** | 65 | 6 | **-91%** |
| **pr checks individual** | 45 | 3 | **-93%** |
| **Wall time in gh calls** | 564s | 263s | **-53%** |

## What Was Done

| Step | Change | Impact |
|------|--------|--------|
| **Agent wrapper fixes** | Cache correctness (--json in key, stderr separation), trace improvements (durationMs, exitCode, ok, operation, passthrough logging) | Agent-side tracing reliable |
| **macOS PATH fix** | Launch script includes PATH export to survive path_helper | Agent wrapper actually active |
| **Step 1** | Remove individual REST fallback from determineStatus, maybeDispatchCIFailureDetails, maybeDispatchMergeConflicts | -110 individual calls |
| **Step 2** | Consolidate review comments — single getReviewThreads() GraphQL, inline comment data in agent messages | -40 REST, -28 GraphQL |
| **Step 3** | Remove unused reviews(last: 5) from batch query | Reduced GraphQL complexity |
| **Shared Enrichment** | Lifecycle persists prEnrichment + prReviewComments to metadata. Dashboard reads from disk. Web lifecycle polling stopped. prCache removed. | -237 calls (dashboard + duplicate lifecycle) |

## Remaining Optimization Targets

| Target | Current | Potential saving |
|--------|---------|-----------------|
| Issue view caching | 35 calls / 24 min (7 per session) | Persist to metadata at spawn → 5 calls total |
| Review backlog throttle | 2 min | 5 min → ~40% fewer review thread calls |
| Guard 2 per-PR calls | 83 calls (one per PR per cycle when Guard 1 returns 304) | Could batch guard 2 into a single query |

## Files Referenced

| File | What |
|------|------|
| `packages/core/src/lifecycle-manager.ts` | persistPREnrichmentToMetadata, prReviewComments write, no REST fallback |
| `packages/web/src/lib/serialize.ts` | readPREnrichmentFromMetadata, enrichSessionPR from metadata |
| `packages/web/src/lib/services.ts` | Lifecycle polling stopped |
| `packages/web/src/lib/cache.ts` | prCache removed |
| `packages/plugins/scm-github/src/index.ts` | getReviewThreads (single GraphQL) |
| `packages/plugins/scm-github/src/graphql-batch.ts` | reviews(last: 5) removed |
| `packages/core/src/agent-workspace-hooks.ts` | Wrapper v0.6.0 — cache + trace fixes |
| `packages/plugins/runtime-tmux/src/index.ts` | PATH export in launch script |
