# REST API with ETag Caching — Design Document

## Executive Summary

This document describes the design for implementing REST API with ETag-based conditional requests to solve GitHub rate limit issues when running 35+ parallel sessions in the Agent Orchestrator.

**Key Outcome:** Scale from ~35 concurrent PRs to 500+ concurrent PRs without hitting GitHub rate limits, while maintaining 30-second polling intervals and ensuring no stale data.

---

## 1. Problem Analysis

### 1.1 Current Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Lifecycle Manager                          │
│                    (polls every 30s)                     │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
            ┌───────────────────────────────┐
            │   GraphQL Batch Query      │
            │   (graphql-batch.ts)       │
            └───────────┬───────────────┘
                        │
                        ▼
              ┌───────────────────────────┐
              │   GitHub GraphQL API      │
              │   (5,000 points/hr)     │
              └───────────────────────────┘
```

### 1.2 Current Implementation Details

**File:** `packages/plugins/scm-github/src/graphql-batch.ts`

The GraphQL batch query fetches all PRs using aliases:

```graphql
query BatchPRs($owner0: String!, $repo0: String!, $number0: Int!) {
  pr0: repository(owner: $owner0, name: $repo0) {
    pullRequest(number: $number0) {
      state
      mergeable
      reviewDecision
      reviews(last: 5) { ... }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {  # ← EXPENSIVE!
                nodes { ... }
              }
            }
          }
        }
      }
    }
  }
  pr1: repository(...) { ... }
  # ... up to 25 PRs per query
}
```

### 1.3 Rate Limit Calculation

**GraphQL Rate Limit:** 5,000 points/hour

**Per-PR Cost Breakdown:**

| Field | Cost (points) | Reason |
|-------|---------------|--------|
| Repository lookup | 1 | Top-level repository object |
| PullRequest node | 1 | PR metadata |
| Reviews (last: 5) | 5 | 5 review objects |
| Commits (last: 1) | 1 | Commit object |
| statusCheckRollup | 1 | Rollup state |
| **contexts(first: 100)** | **100** | Individual CI checks |
| **Total** | **~109** | |

*Note: GitHub's complexity scoring may differ, but this is the order of magnitude.*

**Scenario Analysis:**

| Concurrent PRs | PRs per Poll | Polls/hr | Points/hr | % of Limit | Status |
|----------------|---------------|-----------|-----------|--------------|--------|
| 10 | 10 | 120 | 13,080 | 262% ❌ |
| 20 | 20 | 120 | 26,160 | 523% ❌ |
| 35 | 35 | 120 | 45,780 | 916% ❌ |
| 50 | 50 | 120 | 65,400 | 1,308% ❌ |

**Result:** Current architecture cannot scale beyond ~35 concurrent PRs at 30s polling.

### 1.4 Why Previous Attempts Fall Short

#### Attempt 1: GraphQL Batching (PR #637)
- **Idea:** Reduce HTTP calls by batching multiple PRs into one GraphQL query
- **Result:** Reduced from N×3 REST calls to 1 GraphQL query
- **Problem:** Just moved bottleneck from REST's 5,000 req/hr to GraphQL's 5,000 points/hr

#### Attempt 2: Optimize GraphQL Query
- **Idea:** Remove `contexts(first: 100)` expansion, use only `statusCheckRollup.state`
- **Result:** Reduced cost from ~109 to ~10 points per PR
- **Problem:** Still scales linearly; 100 PRs × 120 polls × 10 pts = 120,000 pts/hr (still over)

#### Attempt 3: TTL Caching
- **Idea:** Only re-fetch PRs where `updated_at` timestamp changed
- **Problem:** PR `updated_at` does NOT update when CI status changes
- **Result:** Stale CI data — defeats the purpose of polling

---

## 2. Proposed Solution: REST API with ETags

### 2.1 Core Concept

GitHub's REST API supports **conditional requests** using ETag (Entity Tag) headers:

1. **First request:** GitHub returns data + `ETag` header
2. **Subsequent request:** Client sends `If-None-Match: <ETag>` header
3. **GitHub response:**
   - If data unchanged: **304 Not Modified** (no rate limit cost!)
   - If data changed: **200 OK** with new data + new ETag

**Key Insight:** 304 responses are **free** — they do not count against the 5,000 requests/hour limit.

### 2.2 Why This Solves the Problem

#### Benefit 1: Separate Rate Limit Bucket

| API Type | Rate Limit | Pool | Used By |
|-----------|-------------|-------|----------|
| REST API | 5,000 req/hr | Core API | Current implementation (very little) |
| GraphQL API | 5,000 pts/hr | GraphQL | Current implementation (exhausted) |

By moving to REST, we have an **entirely fresh 5,000 req/hr budget**.

#### Benefit 2: Zero Cost for Unchanged Data

When a PR is idle (no reviews, CI hasn't changed, no edits):
- GraphQL: Still costs ~10 points per poll
- REST + ETag: Costs 0 points (304 response)

With typical workload where **70-90% of PRs are idle** at any given moment, this is massive.

#### Benefit 3: Catches ALL Changes

ETags update whenever the resource changes:

| Event | Updates PR ETag | Updates Commit ETag | Detection |
|--------|------------------|---------------------|-----------|
| Review comment added | ✅ | ❌ | PR ETag mismatch → fetch |
| Review approved/rejected | ✅ | ❌ | PR ETag mismatch → fetch |
| PR title/description edited | ✅ | ❌ | PR ETag mismatch → fetch |
| CI status changes | ❌ | ✅ | Commit ETag mismatch → fetch |
| New commit pushed | ✅ | ✅ | Either ETag mismatch → fetch |
| PR merged/closed | ✅ | ❌ | PR ETag mismatch → fetch |

**No stale data possible** — ETag changes detect everything.

#### Benefit 4: Simple to Implement

- Uses standard REST API (no GraphQL complexity)
- Leverages existing `gh` CLI infrastructure
- No infrastructure changes (no webhooks, no new servers)
- Backward compatible with existing GraphQL batch

### 2.3 Rate Limit Comparison

**Scenario:** 100 concurrent PRs, 30s polling, 10% changing per poll

| Metric | GraphQL Only | REST + ETags |
|--------|--------------|----------------|
| PRs per poll | 100 | 100 |
| PRs changing | 100 | 10 |
| REST calls per poll | 0 | 300 (3 per PR) |
| GraphQL calls per poll | 1 batch | 0 |
| 304 responses per poll | 0 | 270 (90% of PRs) |
| REST points used/hr | 0 | 3,600 (72%) ✅ |
| GraphQL points used/hr | 48,000 (960%) | 0 ✅ |
| **Status** | ❌ Exceeded | ✅ Under budget |

**Max Capacity at 30s polling:**

| Approach | Max PRs (full change) | Max PRs (10% change) |
|----------|------------------------|------------------------|
| GraphQL | ~45 | ~500 |
| REST + ETags | ~1,600 | ~500+ |

**Conclusion:** REST + ETags enables scaling to 500+ concurrent PRs.

---

## 3. Architecture Design

### 3.1 New Component Structure

```
packages/
├── core/
│   └── src/
│       ├── types.ts                 # Add enrichPREtagged? to SCM interface
│       ├── lifecycle-manager.ts       # Use ETag enrichment, persistent cache
│       └── observability.ts         # Add etag_batch metric
└── plugins/
    └── scm-github/
        └── src/
            ├── index.ts                # Export enrichPREtagged
            ├── graphql-batch.ts         # Optimize as fallback
            └── rest-enrichment.ts      # NEW: ETag-based enrichment
```

### 3.2 Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Lifecycle Manager                          │
│              populatePREnrichmentCache()                    │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────┐
        │   ETag Enrichment Module    │
        │   (rest-enrichment.ts)       │
        └───────────────────────────────────┘
                        │
        ┌───────────┬───────────────┬───────────────┐
        │           │               │               │
        ▼           ▼               ▼               ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
   │   PR    │ │   CI     │ │ Reviews  │ │  Cache   │
   │   GET   │ │   GET   │ │   GET   │ │  Store  │
   └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘
        │            │            │           │
        │            │            │           │
        ▼            ▼            ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ GitHub  │ │ GitHub  │ │ GitHub  │
   │ REST    │ │ REST    │ │ REST    │
   │ 304=Free│ │ 304=Free │ │ 304=Free │
   └────┬────┘ └────┬────┘ └────┬────┘
        │            │            │
        └────────────┴────────────┘
                        │
                        ▼
        ┌───────────────────────────┐
        │   Combine Results        │
        │   Track Metrics         │
        │   Return Map<PR, Data> │
        └───────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│           Lifecycle Manager Cache (persistent)               │
│           prEnrichmentCache: Map                          │
│           Key: "owner/repo#number"                         │
│           Value: { data, etags, lastChecked }              │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 REST Enrichment Module Design

**File:** `packages/plugins/scm-github/src/rest-enrichment.ts`

#### 3.3.1 ETag Cache

```typescript
interface ETagCache {
  // ETag for PR data endpoint
  prEtag: Map<string, string>;  // Key: "owner/repo#number"

  // ETag for CI status endpoint
  ciEtag: Map<string, string>;  // Key: "owner/repo/sha"

  // ETag for reviews endpoint
  reviewsEtag: Map<string, string>;  // Key: "owner/repo#number"

  // Full response data cache (for 304 responses)
  dataCache: Map<string, any>;  // Same keys as ETags
}
```

#### 3.3.2 Conditional Request Function

```typescript
/**
 * Perform conditional GET request with ETag support
 *
 * @returns { data, changed, etag }
 *   - data: Response body (or cached data if 304)
 *   - changed: true if data was refreshed, false if 304
 *   - etag: New ETag from response (or unchanged)
 */
async function conditionalRequest<T>({
  endpoint,
  etagCache,
  dataCache,
  parseFn,
}: ConditionalRequestParams<T>): Promise<{ data: T, changed: boolean, etag: string }>
```

#### 3.3.3 Three Parallel Fetches

For each PR, fetch in parallel:

1. **GET `/repos/{owner}/{repo}/pulls/{number}`**
   - Fields: `state,title,additions,deletions,isDraft,mergeable,mergeStateStatus,headRefName,headRefOid,headRefOid`
   - ETag key: `"owner/repo#number"`

2. **GET `/repos/{owner}/{repo}/commits/{sha}/check-runs`**
   - Fields: `name,conclusion,status,startedAt,completedAt`
   - ETag key: `"owner/repo/sha"`

3. **GET `/repos/{owner}/{repo}/pulls/{number}/reviews`**
   - Fields: `author,state,submittedAt,body`
   - ETag key: `"owner/repo#number"`

### 3.4 Result Assembly

```typescript
function assemblePREnrichmentData(
  prData: GitHubPRResponse,
  ciData: CICheckResponse[],
  reviewsData: ReviewResponse[],
): PREnrichmentData
```

### 3.5 Observability Integration

Track:
- Cache hit rate: `(totalPRs - fetchedPRs) / totalPRs`
- 304 responses count (API calls saved)
- Failed requests count
- Batch duration

---

## 4. Lifecycle Manager Changes

### 4.1 Persistent Cache Structure

**Current (line 208):**
```typescript
const prEnrichmentCache = new Map<string, PREnrichmentData>();
// Cleared every poll cycle in populatePREnrichmentCache() line 216
```

**New:**
```typescript
interface CacheEntry {
  data: PREnrichmentData;
  prEtag: string | null;
  ciEtag: string | null;
  reviewsEtag: string | null;
  lastChecked: number;  // Millisecond timestamp
}

const prEnrichmentCache = new Map<string, CacheEntry>();
// Persists across poll cycles
```

### 4.2 Cache Cleanup Logic

Prevent memory leak by removing entries for completed/stale PRs:

```typescript
function cleanupCache(activePRNumbers: Set<number>): void {
  const now = Date.now();
  const STALE_THRESHOLD = 10 * 60_000; // 10 minutes

  for (const [key, entry] of prEnrichmentCache.entries()) {
    const prNumber = extractPrNumber(key);

    // Remove merged/closed PRs
    if (entry.data.state === 'merged' || entry.data.state === 'closed') {
      prEnrichmentCache.delete(key);
      continue;
    }

    // Remove entries for PRs no longer active
    if (!activePRNumbers.has(prNumber)) {
      prEnrichmentCache.delete(key);
      continue;
    }

    // Remove stale entries (safety net)
    if (now - entry.lastChecked > STALE_THRESHOLD) {
      prEnrichmentCache.delete(key);
    }
  }
}
```

### 4.3 Enrichment Method Selection

```typescript
// In populatePREnrichmentCache():

const scm = registry.get<SCM>("scm", pluginKey);
let enrichmentData: Map<string, PREnrichmentData>;

// Primary path: ETag-based REST (most efficient)
if (scm?.enrichPREtagged) {
  enrichmentData = await scm.enrichPREtagged(pluginPRs, observer);
}
// Fallback path: GraphQL batch (existing implementation)
else if (scm?.enrichSessionsPRBatch) {
  enrichmentData = await scm.enrichSessionsPRBatch(pluginPRs, observer);
}
```

### 4.4 Cache Update Logic

```typescript
// After getting enrichment data:

for (const [key, freshData] of enrichmentData.entries()) {
  const existing = prEnrichmentCache.get(key);

  if (existing) {
    // Update ETags and data, keep lastChecked
    existing.data = freshData;
    existing.lastChecked = Date.now();
    // ETags come from rest-enrichment module
  } else {
    // New entry
    prEnrichmentCache.set(key, {
      data: freshData,
      prEtag: null,
      ciEtag: null,
      reviewsEtag: null,
      lastChecked: Date.now(),
    });
  }
}
```

---

## 5. Implementation Phases

### Phase 1: Core Infrastructure (6 hours)

**Goal:** Create the ETag enrichment module

**Tasks:**
1. Create `packages/plugins/scm-github/src/rest-enrichment.ts`
2. Implement `ETagCache` class
3. Implement `conditionalRequest()` function
4. Implement `getPRConditional()`, `getCIStatusConditional()`, `getReviewsConditional()`
5. Implement `enrichPREtagged()` main function
6. Add unit tests in `packages/plugins/scm-github/test/rest-enrichment.test.ts`

**Deliverables:**
- Working ETag enrichment module
- Unit tests passing
- Cache hit/miss logic verified

### Phase 2: Interface Integration (2 hours)

**Goal:** Extend SCM interface to support ETag enrichment

**Tasks:**
1. Add `enrichPREtagged?` to `SCM` interface in `packages/core/src/types.ts`
2. Update type definitions for cache entry structure if needed

**Deliverables:**
- SCM interface extended
- TypeScript compilation successful

### Phase 3: Lifecycle Manager Update (3 hours)

**Goal:** Integrate ETag enrichment into polling loop

**Tasks:**
1. Modify `prEnrichmentCache` structure to persistent cache
2. Update `populatePREnrichmentCache()` to use `enrichPREtagged()`
3. Add cache cleanup logic
4. Add fallback to GraphQL batch
5. Update observability tracking

**Deliverables:**
- Lifecycle manager uses ETag enrichment
- Cache persists across polls
- Cleanup prevents memory leaks
- Fallback path preserved

### Phase 4: GitHub Plugin Export (1 hour)

**Goal:** Expose ETag enrichment from GitHub plugin

**Tasks:**
1. Import `enrichPREtagged` in `packages/plugins/scm-github/src/index.ts`
2. Add to `createGitHubSCM()` return object
3. Export from module

**Deliverables:**
- GitHub plugin exports ETag enrichment
- Backward compatible

### Phase 5: GraphQL Optimization (2 hours)

**Goal:** Optimize GraphQL as fallback

**Tasks:**
1. Remove `contexts(first: 100)` from `PR_FIELDS` in `graphql-batch.ts`
2. Keep only `statusCheckRollup.state`
3. Verify cost reduction

**Deliverables:**
- GraphQL cost ~10 points per PR
- GraphQL viable as fallback

### Phase 6: Testing & Verification (4 hours)

**Goal:** Validate implementation

**Tasks:**
1. Run unit tests
2. Run integration tests
3. Manual testing with 20+ concurrent PRs
4. Monitor rate limit usage
5. Verify cache hit rates

**Deliverables:**
- All tests passing
- Rate limit under 30%
- No stale data detected

---

## 6. Risk Assessment

### 6.1 Technical Risks

| Risk | Impact | Mitigation |
|-------|----------|------------|
| gh CLI doesn't expose ETag headers | High | Use octokit/rest.js directly if needed; gh CLI typically supports this |
| Cache memory growth | Medium | Implement cleanup logic; max 10 min TTL |
| ETag collision (hash collision) | Low | GitHub ETags are opaque strings, not hashes; unlikely |
| Concurrent cache access | Low | Use Map (single-threaded in Node) |
| GitHub changes ETag format | Very Low | ETags are standard HTTP; unlikely to change |

### 6.2 Operational Risks

| Risk | Impact | Mitigation |
|-------|----------|------------|
| Regression from GraphQL batch | Medium | GraphQL batch remains as fallback; gradual rollout |
| Testing with real GitHub tokens | Medium | Use test tokens with rate limit monitoring |
| Cache invalidation bugs | High | Add safety TTL; 10-minute stale removal |

---

## 7. Success Criteria

The implementation is successful when:

- [ ] 100 PRs can be polled every 30s without exceeding GitHub rate limits
- [ ] Cache hit rate >70% for typical workload (PRs mostly idle)
- [ ] CI status changes detected within 30s (no stale data >30s old)
- [ ] No infrastructure changes required (no webhooks, no new servers)
- [ ] Backward compatible — existing GraphQL batch works as fallback
- [ ] Observability metrics emitted for cache performance monitoring
- [ ] All unit tests pass
- [ ] Integration tests pass with real GitHub API
- [ ] Memory usage stable (no leaks over 24+ hour runs)

---

## 8. Rollback Plan

If issues arise after deployment:

1. **Feature flag:** Can disable ETag enrichment by not exporting `enrichPREtagged`
2. **Fallback preserved:** GraphQL batch implementation untouched
3. **Canary rollout:** Deploy to subset of projects first
4. **Quick revert:** Remove ETag export, restart orchestrator

---

## 9. References

- GitHub REST API Conditional Requests: https://docs.github.com/rest/overview/resources-in-the-rest-api#conditional-requests
- ETag HTTP Header: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag
- 304 Not Modified: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/304
- Current Implementation: PR #637, `packages/plugins/scm-github/src/graphql-batch.ts`
- Core Types: `packages/core/src/types.ts`
