# AO-Side Rate-Limit Reduction Plan

**Date:** 2026-04-22
**Branch:** `feat/gh-rate-limiting`
**Based on:** [gh-rate-limit-trace-report.md](./gh-rate-limit-trace-report.md)

## Context

5-session, 15-minute trace showed 465 AO-side gh calls. GraphQL budget consumption projected at **41%/hour with just 5 sessions** — the bottleneck that limits scaling to ~12 sessions before exhausting the hourly budget.

The biggest contributors to unnecessary traffic:

| Source | Calls (15 min) | % of Total | Root Cause |
|--------|:--------------:|:----------:|------------|
| Individual `pr view` fallback | 65 | 14% | Batch cache miss → 5 individual REST calls per PR |
| Individual `pr checks` fallback | 45 | 10% | Same — fallback path from batch miss |
| Review threads (GraphQL) | 55 | 12% | Standalone query every 2 min, not in batch |
| Automated comments (REST) | 40 | 9% | Standalone fetch every 2 min, no ETag |

## Step 1: Remove individual REST fallback from `determineStatus()`

### What

Remove the fallback code path at `lifecycle-manager.ts:765-810` that makes individual `getPRState()`, `getCISummary()`, `getReviewDecision()`, and `getMergeability()` REST calls when the batch enrichment cache misses.

### Why

- **110 calls eliminated** (65 `pr view` + 45 `pr checks`) — 24% of all traffic.
- **169 seconds of wall time saved** per 15-minute window.
- The batch enrichment runs every 30 seconds. If it misses a PR in one cycle, it picks it up in the next. A 30-second delay in status detection is acceptable — agents don't operate at sub-minute precision.
- **Zero batch failures occurred** in the real 15-minute trace. All 44 batch calls succeeded. The fallback is insurance for an event that didn't happen once.
- Even if the batch fails, the session status stays at its last known value. The agent keeps working. The next cycle (30s later) retries the batch. The fallback has the same limitation during a GitHub outage — individual REST calls would also fail.

### What happens without fallback

```
Poll cycle N:
  1. Batch enrichment runs → cache populated for PRs
  2. determineStatus() checks cache → hit → uses cached data ✓

Poll cycle N (cache miss — PR just created or batch failed):
  1. Batch enrichment runs → PR not in cache (or batch failed)
  2. determineStatus() checks cache → miss → no fallback
  3. Falls through to agent report path (line 824+)
     - If agent reported state → uses agent report
     - If no agent report → status stays unchanged
  4. Session remains at current status for this cycle

Poll cycle N+1 (30 seconds later):
  1. Batch enrichment runs again → PR now in cache ✓
  2. determineStatus() → cache hit → correct status
```

**Worst case:** 30-second delay in detecting a state change (PR merged, CI failed, review approved). None of these are time-critical.

### Risk assessment

| Scenario | Impact | Likelihood |
|----------|--------|------------|
| Batch fails once, recovers next cycle | 30s delay | Low (0 failures in 15-min trace) |
| Batch fails repeatedly (GitHub outage) | Status stale until recovery | Very low — and fallback would also fail |
| PR just created, not yet in batch | 30s delay on first detection | Expected — happens once per session |
| GraphQL rate limit hit, REST still available | Can't fall back to REST | Unlikely at current volumes |

### Code change

**File:** `packages/core/src/lifecycle-manager.ts`

**Before (lines 755-810):**
```typescript
if (cachedData) {
  return commit(resolvePREnrichmentDecision(cachedData, { ... }));
}

// Individual fallback calls (TO BE REMOVED):
const prState = await scm.getPRState(session.pr);
// ... 45 lines of individual REST calls
```

**After:**
```typescript
if (cachedData) {
  return commit(resolvePREnrichmentDecision(cachedData, { ... }));
}

// No fallback — batch will populate cache on next cycle (30s).
// Status stays unchanged for this cycle.
```

### Expected impact

| Metric | Before | After |
|--------|--------|-------|
| Individual `pr view` calls / 15 min | 65 | 0 |
| Individual `pr checks` calls / 15 min | 45 | 0 |
| Total calls / 15 min | 465 | ~355 |
| REST consumed / 15 min | 42 | ~20 |
| Wall time in gh calls | 564s | ~395s |

---

## Future Steps (not yet planned in detail)

### Step 2: Fold review threads into batch GraphQL query
Add `reviewThreads(first: 100)` to the existing `generateBatchQuery()` in `graphql-batch.ts`. Eliminates 55 standalone GraphQL calls per 15 minutes. Zero extra API calls since it piggybacks on the existing batch request.

### Step 3: Add ETag to automated comments REST call
`GET /repos/.../pulls/.../comments` supports ETags. Add If-None-Match header. Most calls return 304 when comments haven't changed.

### Step 4: Increase review backlog throttle
Change `REVIEW_BACKLOG_THROTTLE_MS` from 2 minutes to 5 minutes. Simple config change, cuts ~60% of review backlog traffic.

### Step 5: Cache issue data in session metadata
Pass issue data from initial fetch to `generatePrompt()` instead of re-fetching. Saves ~22 `gh issue view` calls per 15 minutes.
