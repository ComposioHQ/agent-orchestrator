# D4 AO-Side Reduction Plan

## Goal

Reduce redundant GitHub traffic from AO-owned code paths (lifecycle polling, SCM batch, CLI commands) without changing the user-visible lifecycle model.

Agent-side `gh` call reduction is covered separately in [D4-wrapper-cache-plan.md](./D4-wrapper-cache-plan.md). That plan also includes the session-manager changes needed to make the `~/.ao/bin/gh` wrapper universal for all agents (including Claude Code).

## Scope

This plan covers four changes:

1. **Phase 2 skip**: if a PR is auto-detected in the current poll, persist it and skip same-poll live SCM fallback.
2. **Phase 4/5 cache-first**: prefer cached PR enrichment data before making individual SCM calls.
3. **PR-scoped ETag**: replace repo-scoped Guard 1 with PR-scoped ETag checks and refresh only changed PRs.
4. **Metadata-first PR reuse**: AO-owned paths (`ao status`, lifecycle) should prefer known PR metadata before calling `detectPR()`.

## Current Architecture

### Persistent SCM cache

The real cross-poll cache lives in `packages/plugins/scm-github/src/graphql-batch.ts`.

- `etagCache` at [graphql-batch.ts:69](/Users/adilshaikh/Desktop/ao/packages/plugins/scm-github/src/graphql-batch.ts:69)
- `prMetadataCache` at [graphql-batch.ts:131](/Users/adilshaikh/Desktop/ao/packages/plugins/scm-github/src/graphql-batch.ts:131)
- `prEnrichmentDataCache` at [graphql-batch.ts:150](/Users/adilshaikh/Desktop/ao/packages/plugins/scm-github/src/graphql-batch.ts:150)

These survive across polls and decide whether GraphQL can be skipped.

### Per-poll lifecycle cache

Lifecycle manager keeps a temporary cache only for the current poll:

- `prEnrichmentCache` at [lifecycle-manager.ts:325](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:325)
- cleared at [lifecycle-manager.ts:342](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:342)
- repopulated from SCM batch results in [lifecycle-manager.ts:442](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:442)

This cache is reused later in the same poll by:

- Phase 2 status decisions at [lifecycle-manager.ts:746](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:746)
- Phase 4 CI details at [lifecycle-manager.ts:1352](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:1352)
- Phase 5 merge conflict details at [lifecycle-manager.ts:1479](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:1479)

### Metadata-backed PR identity

Session metadata already persists `pr`:

- metadata contract at [types.ts:1532](/Users/adilshaikh/Desktop/ao/packages/core/src/types.ts:1532)
- read path at [metadata.ts:69](/Users/adilshaikh/Desktop/ao/packages/core/src/metadata.ts:69)
- lifecycle auto-detect writeback at [lifecycle-manager.ts:726](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:726)
- agent `gh pr create` wrapper writeback at [agent-workspace-hooks.ts:232](/Users/adilshaikh/Desktop/ao/packages/core/src/agent-workspace-hooks.ts:232)

`session.pr` is reconstructed from `lifecycle.pr.url ?? meta["pr"]` in [session-from-metadata.ts:46](/Users/adilshaikh/Desktop/ao/packages/core/src/utils/session-from-metadata.ts:46).

---

## Change 1: Phase 2 skip same-poll fallback after PR auto-detect

### Current behavior

Inside `determineStatus()`:

- PR auto-detect happens at [lifecycle-manager.ts:708](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:708)
- detected PR is assigned to `session.pr` and metadata is updated at [lifecycle-manager.ts:718](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:718) and [lifecycle-manager.ts:726](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:726)
- immediately after that, the same check can enter the per-PR fallback block at [lifecycle-manager.ts:743](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:743) and call:
  - `getPRState()`
  - `getCISummary()`
  - `getReviewDecision()`
  - `getMergeability()`

That fallback is redundant because batch enrichment already ran earlier in the poll and the newly detected PR will not be in `prEnrichmentCache` until the next poll.

### Planned change

Add one ephemeral local flag in `determineStatus()`:

- `let detectedPRThisCycle = false;`

When `detectPR()` succeeds:

- keep `session.pr = detectedPR`
- keep `updateMetadata(..., { pr: detectedPR.url })`
- keep `sessionManager.invalidateCache()`
- keep `lifecycle.pr.number`, `lifecycle.pr.url`, and `lifecycle.pr.lastObservedAt`
- do **not** mark canonical PR state as open in that same branch
- set `detectedPRThisCycle = true`

Then gate the per-PR fallback block:

- if `session.pr && scm && !detectedPRThisCycle`, run the current fallback logic
- if `detectedPRThisCycle`, skip live SCM fallback for this poll

### Why lifecycle still needs a partial PR update

`updateSessionMetadata()` later writes lifecycle-derived fields back to metadata via:

- [lifecycle-manager.ts:1072](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:1072)
- [lifecycle-state.ts:449](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-state.ts:449)

If we stop touching lifecycle PR fields entirely, the final lifecycle metadata patch can wipe the just-written `pr` URL in the same check. The safe approach is:

- update `lifecycle.pr.number`
- update `lifecycle.pr.url`
- update `lifecycle.pr.lastObservedAt`
- defer `lifecycle.pr.state` / `reason` until next poll

### Next-poll inclusion path

This optimization is safe because the next poll:

1. reloads sessions via `sessionManager.list()` at [lifecycle-manager.ts:1870](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:1870)
2. rebuilds `session.pr` from metadata in [session-from-metadata.ts:46](/Users/adilshaikh/Desktop/ao/packages/core/src/utils/session-from-metadata.ts:46)
3. collects those PRs for batch enrichment in [lifecycle-manager.ts:345](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:345)

### Tests

Update or add lifecycle tests:

- extend the existing detect-PR test near [lifecycle-manager.test.ts:700](/Users/adilshaikh/Desktop/ao/packages/core/src/__tests__/lifecycle-manager.test.ts:700) to assert same-poll auto-detect persists metadata but does **not** call:
  - `getPRState`
  - `getCISummary`
  - `getReviewDecision`
  - `getMergeability`
- add a `pollAll()` regression test proving:
  - poll 1 auto-detects the PR
  - poll 2 includes it in batch enrichment
  - later PR classification comes from batch data, not immediate fallback

---

## Change 2: Phase 4 and Phase 5 cache-first behavior

### Phase 4 current behavior

Phase 4 already prefers cache when `ciChecks` is present:

- [lifecycle-manager.ts:1352](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:1352)

Current rule:

- if `cachedEnrichment?.ciChecks !== undefined`, use it
- else fall back to `scm.getCIChecks()`

This should stay, because GraphQL batch intentionally omits `ciChecks` when contexts are truncated:

- [graphql-batch.ts:847](/Users/adilshaikh/Desktop/ao/packages/plugins/scm-github/src/graphql-batch.ts:847)

### Phase 4 plan

Treat Phase 4 as already mostly correct.

Implementation work:

- keep the existing `ciChecks !== undefined` contract
- document it in code comments as the canonical fallback rule
- add tests for the negative case:
  - if cached batch data omits `ciChecks`, Phase 4 must still call `getCIChecks()`

### Phase 5 current behavior

Phase 5 partially prefers cache for conflicts:

- [lifecycle-manager.ts:1479](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:1479)

But it currently does:

- `hasConflicts = cachedData.hasConflicts ?? false`

That treats "field missing" as "no conflicts," which is too aggressive.

### Phase 5 plan

Change conflict derivation to:

1. if `cachedData.hasConflicts` is a boolean, use it
2. else if `cachedData.blockers` exists, derive conflicts from:
   - `cachedData.blockers.includes("Merge conflicts")`
3. else fall back to `scm.getMergeability()`

Relevant data already exists in:

- `PREnrichmentData` in [types.ts:933](/Users/adilshaikh/Desktop/ao/packages/core/src/types.ts:933)
- batch extraction at [graphql-batch.ts:865](/Users/adilshaikh/Desktop/ao/packages/plugins/scm-github/src/graphql-batch.ts:865)

### Tests

Existing tests already cover the cache-first happy path:

- Phase 5 near [lifecycle-manager.test.ts:2364](/Users/adilshaikh/Desktop/ao/packages/core/src/__tests__/lifecycle-manager.test.ts:2364)
- Phase 4 near [lifecycle-manager.test.ts:2415](/Users/adilshaikh/Desktop/ao/packages/core/src/__tests__/lifecycle-manager.test.ts:2415)

Add fallback coverage:

- cache entry with no `ciChecks` still calls `getCIChecks()`
- cache entry with no `hasConflicts` and no `blockers` still calls `getMergeability()`
- cache entry with `blockers` containing `"Merge conflicts"` skips `getMergeability()`

---

## Change 3: PR-scoped ETag guard and selective refresh

### Current behavior

Guard 1 is repo-scoped:

- `ETagCache.prList` at [graphql-batch.ts:57](/Users/adilshaikh/Desktop/ao/packages/plugins/scm-github/src/graphql-batch.ts:57)
- `checkPRListETag()` at [graphql-batch.ts:366](/Users/adilshaikh/Desktop/ao/packages/plugins/scm-github/src/graphql-batch.ts:366)

`shouldRefreshPREnrichment()` groups by repo and sets one repo-wide `guard1DetectedChanges`:

- [graphql-batch.ts:187](/Users/adilshaikh/Desktop/ao/packages/plugins/scm-github/src/graphql-batch.ts:187)

Once any repo change is seen, `enrichSessionsPRBatch()` refreshes all input PRs for that path instead of only changed PRs:

- [graphql-batch.ts:925](/Users/adilshaikh/Desktop/ao/packages/plugins/scm-github/src/graphql-batch.ts:925)

### Planned change

Replace repo-scoped Guard 1 with PR-resource Guard 1:

- current endpoint: `GET /repos/{owner}/{repo}/pulls?...per_page=1`
- new endpoint: `GET /repos/{owner}/{repo}/pulls/{number}`

Cache key changes:

- from `owner/repo`
- to `owner/repo#number`

Recommended changes in `graphql-batch.ts`:

- rename `MAX_PR_LIST_ETAGS` to `MAX_PR_RESOURCE_ETAGS`
- replace `ETagCache.prList` with `ETagCache.prResource`
- replace `get/setPRListETag()` with `get/setPRResourceETag(owner, repo, number)`
- replace `checkPRListETag()` with `checkPRResourceETag(owner, repo, number)`

Guard 2 stays the same in principle:

- commit-status ETag check using `owner/repo#sha`
- [graphql-batch.ts:424](/Users/adilshaikh/Desktop/ao/packages/plugins/scm-github/src/graphql-batch.ts:424)

### New guard result shape

`shouldRefreshPREnrichment()` should stop returning only a boolean and instead return a refresh plan:

```ts
interface PREnrichmentRefreshPlan {
  shouldRefresh: boolean;
  prsToRefresh: PRInfo[];
  cachedPRKeys: string[];
  details: string[];
}
```

### New decision logic

For each tracked PR:

1. Run PR-resource Guard 1.
2. If Guard 1 returns changed or errors:
   - mark only that PR for refresh
3. If Guard 1 returns 304:
   - if full enrichment cache is missing, refresh that PR
   - if metadata cache is missing or `headSha === null`, refresh that PR
   - otherwise run Guard 2 commit-status ETag
4. If Guard 2 returns 304:
   - reuse cached enrichment for that PR
5. If Guard 2 returns changed:
   - refresh that PR

### `enrichSessionsPRBatch()` changes

Update [graphql-batch.ts:925](/Users/adilshaikh/Desktop/ao/packages/plugins/scm-github/src/graphql-batch.ts:925) so it:

- seeds the result map from cached unchanged PRs
- batches only `prsToRefresh`
- returns cached unchanged PRs even if the GraphQL fetch for changed PRs partially fails

This is the key structural change: selective refresh instead of all-or-nothing refresh.

### Edge cases

- treat missing full enrichment cache or missing metadata cache as "refresh required"
- do not reuse stale cache if a changed PR disappears from GraphQL response
- old commit-status ETags keyed by obsolete SHAs can be left for LRU eviction
- optional hardening: dedupe `PRInfo[]` by `owner/repo#number` before guarding

### Tests

Update `packages/plugins/scm-github/test/graphql-batch.test.ts`:

- rename and update PR-resource ETag helpers
- replace repo-level Guard 1 expectations with PR-resource expectations
- add guard-planner tests:
  - one changed PR and one unchanged PR in the same repo → refresh only changed PR
  - Guard 1 304 + missing full data → refresh that PR
  - Guard 1 304 + missing metadata or `headSha === null` → refresh that PR
  - Guard 1 304 + Guard 2 304 → reuse cache only
  - Guard 1 304 + Guard 2 200 → refresh only that PR
- add `enrichSessionsPRBatch()` tests:
  - merge cached unchanged PRs with fetched changed PRs
  - GraphQL query includes only `prsToRefresh`
  - unchanged cached PRs are still returned if the changed subset fails

---

## Change 4: Metadata-first PR reuse (AO-owned paths only)

Agent-side wrapper caching for `gh pr list --head` and `gh issue view` is covered in [D4-wrapper-cache-plan.md](./D4-wrapper-cache-plan.md). This change covers only the AO-owned Node.js code paths.

### Lifecycle hardening

Lifecycle already calls `detectPR()` only when `!session.pr`:

- [lifecycle-manager.ts:708](/Users/adilshaikh/Desktop/ao/packages/core/src/lifecycle-manager.ts:708)

But to make this resilient even if a caller hands lifecycle a stale `Session`, harden it by hydrating from metadata first:

- if `session.pr` is null and `session.metadata["pr"]` exists, reconstruct a minimal PR object from metadata before calling `scm.detectPR()`

Reuse existing parser:

- [packages/core/src/utils/pr.ts](/Users/adilshaikh/Desktop/ao/packages/core/src/utils/pr.ts:1)

### `ao status` fix

The main AO-owned rediscovery bug is in status:

- [packages/cli/src/commands/status.ts:121](/Users/adilshaikh/Desktop/ao/packages/cli/src/commands/status.ts:121)

Current behavior:

- if `branch` exists, it calls `scm.detectPR(session, project)` even if metadata already has `pr`

Plan:

- prefer `session.pr` for `prUrl`, `prNumber`, and SCM follow-up calls
- only fall back to `scm.detectPR()` when there is no known PR object or URL

### Tests

- add lifecycle test: metadata `pr` present, `session.pr` absent or stale, `detectPR()` should not run
- update/add status tests in `packages/cli/__tests__/commands/status.test.ts` to assert:
  - existing PR metadata avoids `detectPR()`
  - CI/review lookups use known PR identity

---

## Recommended Implementation Order

1. Phase 2 skip-same-poll fallback (Change 1)
2. Phase 5 conflict cache fallback hardening (Change 2)
3. Status command metadata-first reuse (Change 4)
4. PR-scoped ETag planner and selective refresh (Change 3)
5. Test expansion and trace validation

The agent-side wrapper cache ([D4-wrapper-cache-plan.md](./D4-wrapper-cache-plan.md)) can be implemented in parallel with steps 1-3 above since it touches different files (wrapper scripts + session-manager environment, vs. lifecycle-manager + graphql-batch + CLI).

---

## Acceptance Criteria

### Lifecycle (Change 1)

- A PR auto-detected in Phase 2 is persisted immediately.
- Same-poll fallback SCM calls are skipped for that newly detected PR.
- Next poll includes the PR in batch enrichment and classifies it there.

### Cache-first Phase 4/5 (Change 2)

- Phase 4 uses cached `ciChecks` when present and falls back only when missing.
- Phase 5 uses cached conflict data when present and falls back only when conflict information is incomplete.

### PR-scoped ETag (Change 3)

- Unrelated PR activity in the same repo no longer refreshes all tracked session PRs.
- Unchanged tracked PRs are served from cache while only changed PRs are refreshed.

### Metadata-first PR reuse (Change 4)

- `ao status` does not call `detectPR()` when a known PR already exists in metadata/session state.
- Lifecycle hydrates `session.pr` from metadata before attempting discovery.

---

## Expected Impact

### Baseline (D4 10-session / 22-minute run)

AO-side trace: **890 calls** total.

| AO-side bucket | Count | % | Rate limit pool |
|----------------|-------|---|-----------------|
| `scm-github gh.pr.list` (detectPR) | 598 | 67.2% | REST core |
| `tracker-github gh.issue.view` | 75 | 8.4% | REST core |
| `scm-github gh.pr.view` | 47 | 5.3% | REST core |
| `scm-github-batch gh.api.guard-pr-list` | 37 | 4.2% | REST core (304s free) |
| `scm-github-batch gh.api.graphql-batch` | 31 | 3.5% | GraphQL |
| `scm-github gh.api.graphql` | 30 | 3.4% | GraphQL |
| `scm-github gh.pr.checks` | 30 | 3.4% | REST core |
| Other | 42 | 4.7% | Mixed |

Rate limit burn: **2502 GraphQL pts/hr**, **16 REST core pts** (over 22 min).

### Per-change reduction estimates

#### Change 1: Phase 2 skip same-poll fallback

When a PR is auto-detected, 4 redundant SCM calls are skipped (getPRState, getCISummary, getReviewDecision, getMergeability). With 10 sessions each detecting once:

| Bucket | Before | After | Saved |
|--------|--------|-------|-------|
| `gh.pr.view` (getPRState) | +10 | 0 | ~10 |
| `gh.pr.checks` (getCISummary) | +10 | 0 | ~10 |
| `gh.api.graphql` (getReviewDecision) | +10 | 0 | ~10 |
| `gh.pr.view` (getMergeability) | +10 | 0 | ~10 |
| **Total** | | | **~40 calls** |

Small in absolute terms but eliminates a code path that is completely wasted work — the batch enrichment in the next poll covers all of this.

#### Change 2: Phase 4/5 cache-first

When batch enrichment already fetched CI checks and merge status, individual follow-up calls are skipped. The batch query covers most polls; individual calls only fire when batch data is incomplete (truncated CI contexts, missing mergeability).

Estimated batch coverage rate: ~60-70% of polls have complete data.

| Bucket | Before | After | Saved |
|--------|--------|-------|-------|
| `gh.pr.checks` (Phase 4 fallback) | 30 | ~10 | ~20 |
| `gh.pr.view` (Phase 5 getMergeability) | ~15 | ~5 | ~10 |
| **Total** | | | **~30 calls** |

Also avoids individual GraphQL review queries when batch data already has review decision.

#### Change 3: PR-scoped ETag guard

This is the highest-leverage change for **GraphQL points**. Currently, any change to any PR in the repo triggers a full GraphQL batch refresh of all tracked PRs. With PR-scoped guards, only the changed PR is refreshed.

In a 10-session run against the same repo, a single PR getting a new CI status currently refreshes all 10 PRs. With PR-scoped guards, only 1 is refreshed; the other 9 serve from cache.

| Metric | Before | After | Saved |
|--------|--------|-------|-------|
| Guard 1 REST calls | 37 (repo-scoped) | ~370 (per-PR, but most return 304 = free) | Net ~0 cost change |
| GraphQL batch calls | 31 | ~10-12 | ~19-21 |
| GraphQL points consumed | ~2502 pts/hr | ~800-1200 pts/hr | **~50-60%** |

The guard calls increase in count (one per PR instead of one per repo) but 304 responses don't cost rate limit. The GraphQL savings are substantial because batches are only run for PRs that actually changed.

#### Change 4: Metadata-first PR reuse

The 598 `detectPR()` calls are the largest single AO-side bucket. Once a PR is known for a session (via wrapper writeback or lifecycle auto-detect), all subsequent polls should skip detectPR(). With 10 sessions over ~44 poll cycles (22min / 30s), each discovering their PR within the first 2-3 polls:

- Calls with PR already known: ~598 - (10 × 3) = ~568 wasted calls
- With metadata-first hydration, these become zero

| Bucket | Before | After | Saved |
|--------|--------|-------|-------|
| `gh.pr.list` (detectPR) | 598 | ~30 (initial discovery only) | **~568 (95%)** |

This also benefits from the wrapper plan: when `gh pr create` writes `pr=` to metadata (via the wrapper), the very next lifecycle poll sees it and never calls detectPR().

### Combined AO-side projection

| Bucket | Before | After (est.) | Saved |
|--------|--------|-------------|-------|
| `gh.pr.list` (detectPR) | 598 | ~30 | ~568 |
| `gh.pr.view` | 47 | ~22 | ~25 |
| `gh.pr.checks` | 30 | ~10 | ~20 |
| `gh.api.graphql` | 30 | ~15 | ~15 |
| `gh.api.graphql-batch` | 31 | ~12 | ~19 |
| `gh.api.guard-pr-list` → `guard-pr-resource` | 37 | ~100 (304s, free) | N/A |
| `gh.issue.view` | 75 | 75 (unchanged, covered by wrapper plan) | 0 |
| Other | 42 | 42 | 0 |
| **Total calls** | **890** | **~306** | **~584 (66%)** |

| Rate limit | Before | After (est.) | Reduction |
|------------|--------|-------------|-----------|
| GraphQL burn | 2502 pts/hr | ~800-1200 pts/hr | **50-60%** |
| REST core calls/hr | ~1630/hr | ~400/hr | **~75%** |

### Combined with wrapper plan

The wrapper plan ([D4-wrapper-cache-plan.md](./D4-wrapper-cache-plan.md)) targets agent-side calls (916 in the same run). Together:

| Source | Before | After (est.) | Saved |
|--------|--------|-------------|-------|
| AO-side (this plan) | 890 | ~306 | ~584 (66%) |
| Agent-side (wrapper plan) | 916 | ~273 | ~643 (70%) |
| **Total `gh` calls** | **1806** | **~579** | **~1227 (68%)** |

The dominant remaining cost after both plans is the legitimate work: initial PR discovery (once per session), batch GraphQL enrichment for PRs that genuinely changed, and issue context fetches (covered by wrapper TTL cache).

---

## Non-goals

- Changing canonical lifecycle precedence so `metadata.pr` overrides `statePayload.pr.url = null`
- New reactions for blocker types other than current merge conflict handling
- Agent-side `gh` caching (covered in [D4-wrapper-cache-plan.md](./D4-wrapper-cache-plan.md))

---

## Companion Plans

| File | Scope |
|------|-------|
| [D4-wrapper-cache-plan.md](./D4-wrapper-cache-plan.md) | Agent-side `gh` wrapper cache (PR discovery + issue context intercepts), session-manager universalization for all agents |
| This file | AO-side lifecycle, SCM batch, and CLI reduction |
