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

### Code changes

Remove fallback paths in **all three functions** that fall back to individual REST calls on batch cache miss:

#### 1. `determineStatus()` — lines 765-810

**File:** `packages/core/src/lifecycle-manager.ts`

Remove the individual `getPRState` + `getCISummary` + `getReviewDecision` + `getMergeability` fallback block (~45 lines). When `cachedData` is null, the function falls through to the agent report path (line 824+) or keeps the previous status.

```typescript
if (cachedData) {
  return commit(resolvePREnrichmentDecision(cachedData, { ... }));
}

// No fallback — batch will populate cache on next cycle (30s).
// Status stays unchanged for this cycle.
```

#### 2. `maybeDispatchCIFailureDetails()` — lines 1357-1363

Remove the `scm.getCIChecks(session.pr)` fallback. If `cachedEnrichment?.ciChecks` is undefined, skip the dispatch for this cycle.

```typescript
if (cachedEnrichment?.ciChecks !== undefined) {
  checks = cachedEnrichment.ciChecks;
} else {
  return; // batch will have it next cycle
}
```

#### 3. `maybeDispatchMergeConflicts()` — lines 1486-1492

Remove the `scm.getMergeability(session.pr)` fallback (3-4 REST calls). If `cachedData` is null, skip conflict detection for this cycle.

```typescript
if (cachedData) {
  hasConflicts = cachedData.hasConflicts ?? false;
} else {
  return; // batch will have it next cycle
}
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

## Step 2: Eliminate REST automated comments call — use single GraphQL for all review comments

### What

Remove `getAutomatedComments()` (REST call) entirely. The existing `getPendingComments()` GraphQL call already fetches **all** review threads (human + bot) via `reviewThreads(first: 100)`. Both calls currently fetch overlapping data and filter to opposite sides:

- `getPendingComments` (GraphQL) → fetches all threads → keeps human, discards bot
- `getAutomatedComments` (REST) → fetches all comments → keeps bot, discards human

Replace with a single GraphQL call that returns both, split locally in the lifecycle manager.

### Why

- **40 REST calls eliminated** per 15 minutes (the entire `getAutomatedComments` REST pagination loop).
- **No data loss.** The GraphQL `reviewThreads` query returns the same fields the REST call provides (author, body, path, line, url), plus `isResolved` which REST doesn't have.
- The REST call fetches ALL comments (human + bot) just to keep bots — wasteful for PRs with many human comments.

### How

1. **Modify `getPendingComments()`** to return both human and bot comments (or split into two arrays). Currently filters out bots at line 971:
   ```typescript
   return !BOT_AUTHORS.has(author);  // ← remove this filter
   ```

2. **Lifecycle manager splits locally** — the consumer at `lifecycle-manager.ts:1157-1160` receives one response and partitions by author:
   - `BOT_AUTHORS.has(author)` → automated comments pipeline (fingerprint + reaction)
   - `!BOT_AUTHORS.has(author)` → human comments pipeline (fingerprint + reaction)

3. **Remove `getAutomatedComments()`** from `scm-github/index.ts` and its REST pagination loop (lines 992-1066).

4. **Update the SCM interface** in `types.ts` if `getAutomatedComments` is part of the interface contract.

### Include comment data in agent reaction message

Currently the reaction messages are static strings that **tell the agent to call `gh`** to fetch comments:

```
"There are review comments on your PR. Check with `gh pr view --comments`
and `gh api` for inline comments. Address each one, push fixes, and reply."
```

This causes the agent to make redundant `gh` read calls for data AO already has.

**Fix:** Construct the reaction message with actual comment data inline:

```
The following review comments are unresolved on your PR (as of just now).
You should not need to re-fetch this data unless you need additional context.

1. src/auth.ts:42 (@reviewer): "Fix error handling here"
   https://github.com/org/repo/pull/57#discussion_r12345

2. src/utils.ts:15 (@reviewer): "This should be async"
   https://github.com/org/repo/pull/57#discussion_r12346
```

**Key design decisions:**
- Provide thread URL so the agent can reply/interact if it chooses to
- Don't prescribe response behavior (e.g., "reply to each thread") — let the agent decide how to acknowledge the review
- Don't block the agent from calling `gh` — just say "you should not need to" in case something breaks or it needs additional context
- Same approach for bot comments — include the bot findings inline

### Code changes

| File | Change |
|------|--------|
| `packages/plugins/scm-github/src/index.ts` | Modify `getPendingComments()` to return all threads (human + bot). Remove `getAutomatedComments()`. |
| `packages/core/src/types.ts` | Update SCM interface if `getAutomatedComments` is in the contract |
| `packages/core/src/lifecycle-manager.ts` | Split combined response into human/bot locally. Build reaction message with comment data instead of static string. |
| `packages/core/src/config.ts` | Update default reaction messages (remove "check with `gh pr view`" instruction) |

### Expected impact

| Metric | Before | After Step 1+2 |
|--------|--------|----------------|
| REST automated comment calls / 15 min | 40 | 0 |
| GraphQL review thread calls / 15 min | 55 | 55 (unchanged — same call, now serves both) |
| Agent-side `gh` read calls for reviews | ~10-20 per session | ~0 (data provided inline) |
| Total calls / 15 min | ~355 (after Step 1) | ~315 |

---

## Step 3: Remove unused `reviews(last: 5)` from batch query

### What

Remove `reviews(last: 5) { nodes { author { login } state submittedAt } }` from `PR_FIELDS` in `graphql-batch.ts:490-496`.

### Why

This data is fetched on every batch call but **never consumed**. The batch code only uses it for a validation check (`pr["reviews"] === undefined` at line 806) — checking if the response has data. The actual review decision comes from the `reviewDecision` scalar field (line 838), which is separate.

Nobody reads the individual review entries:
- The lifecycle manager uses `reviewDecision` (scalar) — not individual reviews
- The dashboard uses `reviewDecision` (scalar) — not individual reviews
- `PREnrichmentData` has no `reviews` field
- Even after implementing the shared enrichment plan, the dashboard won't need it — `reviewDecision` is sufficient

### Impact

- Reduces GraphQL query complexity on every batch call (44 calls / 15 min)
- Each `reviews(last: 5)` adds 5 nested objects with 3 fields each — unnecessary weight
- No functional change — validation check at line 806 can use other fields (`state`, `title`, `commits`)

### Code change

**File:** `packages/plugins/scm-github/src/graphql-batch.ts`

Remove lines 490-496:
```graphql
  reviews(last: 5) {
    nodes {
      author { login }
      state
      submittedAt
    }
  }
```

Update validation check at line 806 to not reference `reviews`:
```typescript
if (
  pr["state"] === undefined &&
  pr["title"] === undefined &&
  pr["commits"] === undefined  // removed: pr["reviews"] === undefined
) {
```

---

## Future Steps (not yet planned in detail)

### Step 4: Gate detectPR behind Guard 1 ETag

Currently `detectPR()` runs individually per session (`gh pr list --head <branch> --limit 1`) every poll cycle for sessions without a PR — regardless of whether Guard 1 already told us nothing changed in the repo's PR list.

If Guard 1 returns 304 (no PR list changes), no new PRs were created in the repo — every `detectPR` call is guaranteed to return nothing. We're paying for information we already have.

**Proposed flow:**
- Move detectPR out of `determineStatus()` entirely
- Run it inside `populatePREnrichmentCache()`, which already calls Guard 1
- Guard 1 returns 304 → skip all detectPR calls (nothing changed)
- Guard 1 returns 200 → run detectPR for all PR-less sessions, update metadata

```
pollAll()
  → populatePREnrichmentCache(sessions)
      → enrichSessionsPRBatch(prs)
          → Guard 1 → Guard 2 → batch query
      → if Guard 1 returned 200:
          → detectPR for all PR-less sessions
          → if found: update metadata
  → checkSession(s) for each session
      → determineStatus(s)
          → no detectPR call — already handled above
```

No body parsing, no `per_page` change, no flags, no fallback. Just move detectPR to after Guard 1 and only run it when Guard 1 says something changed.

**Impact (10 sessions, no PRs for 10 minutes):**

| Metric | Current | Proposed | Saving |
|--------|---------|----------|--------|
| detectPR calls (10 sessions, 20 cycles) | 200 | ~10 (only on 200 cycles) | **-95%** |
| Guard 1 calls | ~20 | ~20 | 0 |

**Tradeoff:** max 30-second delay (one poll cycle) in discovering a just-created PR. If an agent creates a PR at T+5s and Guard 1 ran at T+0s (returned 304), discovery waits until T+30s when Guard 1 returns 200. Agents aren't blocked on PR discovery.

In the original 5-session trace, `detectPR` was 82 calls out of 465 total (18%). At 10+ sessions with slow PR creation, it dominates.

### Step 5: Increase review backlog throttle
Change `REVIEW_BACKLOG_THROTTLE_MS` from 2 minutes to 5 minutes. Simple config change, cuts ~60% of review backlog traffic. Would reduce the 55 GraphQL calls to ~22.

### Step 6: Cache issue data in session metadata
Persist issue data (number, title, body, url, state, labels, assignees) to session metadata at spawn time. Currently fetched 27 times for 5 sessions — should be 5 (once per session).

The tracker plugin already has a 5-minute TTL in-memory cache (`ISSUE_CACHE_TTL_MS` at `tracker-github/index.ts:121`), but it's per-process — both CLI and web create their own instance.

**Fix:** Write issue data to session metadata at spawn. Dashboard reads from metadata. Eliminates all repeated `gh issue view` calls from both processes.

Fields to persist:
- `number`, `title`, `body`, `url` — static for session lifetime
- `state` — changes only when AO closes it (AO already knows)
- `labels`, `assignees` — rarely change

Saves ~22 `gh issue view` calls per 15 minutes.
