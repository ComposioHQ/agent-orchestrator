# Rate Limit Optimization Design Document

**Status:** Draft
**Date:** 2026-03-25
**Issue:** GitHub API rate limits preventing scaling to 35+ parallel sessions
**Constraint:** No webhooks

---

## Table of Contents

1. [Problem Analysis](#problem-analysis)
2. [Answer: Can We Drop contexts(first: 100)?](#answer-can-we-drop-contexts)
3. [Approach 1: Cross-Cycle TTL Caching](#approach-1-ttl-caching)
4. [Approach 2: GraphQL Query Cost Optimization](#approach-2-query-optimization)
5. [Approach 3: Adaptive Polling Frequency](#approach-3-adaptive-polling)
6. [Approach 4: Hybrid REST + GraphQL](#approach-4-hybrid-approach)
7. [Approach 5: ETag / Conditional Requests](#approach-5-etag-conditional-requests)
8. [Recommended Solution](#recommended-solution)
9. [Implementation Roadmap](#implementation-roadmap)

---

## Problem Analysis

### Current Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Current Polling Architecture                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Poll Interval: 30 seconds → 120 polls/hour                         │
│                                                                     │
│  Per poll cycle:                                                      │
│    1. Collect all unique PRs from sessions                       │
│    2. Call GraphQL batch query with ALL PRs                         │
│    3. Clear cache (data lost after poll)                          │
│    4. Check each session status using cached data                      │
│                                                                     │
│  GraphQL Query Fields per PR:                                         │
│    • state, title, additions, deletions                               │
│    • isDraft, mergeable, mergeStateStatus, reviewDecision                │
│    • reviews(last: 5)                                                │
│    • statusCheckRollup {                                              │
│        state                                                           │
│        contexts(first: 100) {  ← COSTLY! ~100 points  │
│          nodes { name, status, conclusion }                                 │
│        }                                                               │
│      }                                                                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Current Cost Analysis

| Scenario | PRs | GraphQL Points/PR | Points/Poll | Polls/Hour | Points/Hour | % of 5,000 Limit |
|-----------|--------|-------------------|--------------|---------------|---------------------|
| Current | 5 | ~40 | ~200 | 24,000 | ❌ 480% |
| Current | 35 | ~40 | ~1,400 | 168,000 | ❌ 3,360% |
| Max Sustainable | ~4 | ~40 | ~160 | 19,200 | ❌ 384% |

**The bottleneck:** At 30s polling with current GraphQL batching, the system can only handle ~4 PRs before hitting the 5,000 GraphQL points/hour limit.

### Data Flow Analysis

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Data Sources in Agent Orchestrator              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ Polling Loop (lifecycle-manager.ts)                          │  │
│  │ Uses GraphQL Batch → enrichSessionsPRBatch()                 │  │
│  │ Returns: ciStatus (passing/failing/pending/none)              │  │
│  │ Purpose: Determine session status for lifecycle decisions                │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ Dashboard UI (CIBadge.tsx)                                │  │
│  │ Uses REST → getCIChecks()                                  │  │
│  │ Command: gh pr checks --json name,state,link,...                │  │
│  │ Returns: Individual check names with status                        │  │
│  │ Purpose: Display detailed CI info in UI                             │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  These are SEPARATE data paths!                                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key Insight:** The polling loop and UI dashboard use different API endpoints for different purposes. Dropping `contexts` from the polling query will NOT affect the UI's ability to show individual check names.

---

## Answer: Can We Drop contexts(first: 100)?

### Short Answer: **YES, absolutely.**

### Detailed Analysis

#### What contexts Are Used For (in Polling)

In `packages/plugins/scm-github/src/graphql-batch.ts`, the `parseCIState()` function:

```typescript
// Line 283-345: How contexts are used
function parseCIState(statusCheckRollup: unknown): CIStatus {
  const rollup = statusCheckRollup as Record<string, unknown>;
  const state = rollup["state"]?.toUpperCase() ?? "";  // ← Top-level state
  const contexts = rollup["contexts"] as { nodes?: Array<GenericContext> };

  // Check individual contexts for detailed state - this takes precedence over
  // top-level state because contexts provide more granular information
  if (contexts?.nodes && contexts.nodes.length > 0) {
    const hasFailing = contexts.nodes.some((c) => {
      // Returns true if ANY check failed
      return c.conclusion === "FAILURE" ||
             c.conclusion === "TIMED_OUT" ||
             c.conclusion === "ACTION_REQUIRED" ||
             c.conclusion === "CANCELLED" ||
             c.conclusion === "ERROR";
    });
    if (hasFailing) return "failing";  // ← Only sets aggregate status

    const hasPending = contexts.nodes.some((c) => {
      // Returns true if ANY check is pending
      return c.status === "PENDING" || c.status === "QUEUED" || ...;
    });
    if (hasPending) return "pending";

    const hasPassing = contexts.nodes.some((c) => {
      // Returns true if ANY check passed
      return c.conclusion === "SUCCESS" || c.state === "SUCCESS";
    });
    if (hasPassing) return "passing";
  }

  // Fall back to top-level state if no contexts found
  if (state === "SUCCESS") return "passing";
  if (state === "FAILURE") return "failing";
  if (state === "PENDING") return "pending";
  return "none";
}
```

#### What the Blocker Message Uses

In `extractPREnrichment()` (line 430-437):

```typescript
// Build blockers list
const blockers: string[] = [];
if (ciStatus === "failing") blockers.push("CI is failing");
if (reviewDecision === "changes_requested") blockers.push("Changes requested in review");
if (reviewDecision === "pending") blockers.push("Review required");
if (hasConflicts) blockers.push("Merge conflicts");
if (isBehind) blockers.push("Branch is behind base branch");
if (isDraft) blockers.push("PR is still a draft");
```

**The blocker message only says "CI is failing" - it doesn't include individual check names!**

#### Where Individual Check Names Are Displayed

The UI shows individual check names via a **completely separate data path**:

```typescript
// packages/web/src/lib/serialize.ts (line 157)
const results = await Promise.allSettled([
  scm.getPRSummary(pr),
  scm.getPRState(pr),
  scm.getCIChecks(pr),  // ← REST API call for detailed CI info
  scm.getCISummary(pr),
  scm.getReviewDecision(pr),
  scm.getMergeability(pr),
]);
```

```typescript
// packages/plugins/scm-github/src/index.ts (line 643)
async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
  const raw = await gh([
    "pr",
    "checks",
    String(pr.number),
    "--repo",
    repoFlag(pr),
    "--json",
    "name,state,link,startedAt,completedAt",  // ← Fetches individual check names
  ]);
  // Returns array of individual checks with names
}
```

### Two Data Paths Summary

| Data Path | Endpoint | Purpose | Returns | Used By |
|-----------|------------|-----------|-----------|-----------|
| Polling Loop | GraphQL `enrichSessionsPRBatch()` | Aggregate CI status (passing/failing/pending) | Lifecycle manager for session status decisions |
| Dashboard UI | REST `getCIChecks()` | Individual check names with status | UI components (CIBadge.tsx) for display |

**Critical Insight:** These are independent data sources. The UI will continue to fetch individual check names via REST even if we drop `contexts(first: 100)` from the GraphQL polling query.

### Conclusion

**YES, you can drop `contexts(first: 100)` from the GraphQL batch query without losing any functionality:**

1. ✅ Session status detection (passing/failing/pending) works via top-level `statusCheckRollup.state`
2. ✅ Blocker messages ("CI is failing") don't use individual check names
3. ✅ UI individual check names are fetched separately via `getCIChecks()` REST call
4. ✅ **Massive savings:** ~75% reduction in GraphQL points per query

---

## Approach 1: Cross-Cycle TTL Caching

### Concept

Instead of clearing the cache every poll cycle, persist enrichment data across polls with timestamps. Only refetch PRs that have actually changed.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Cross-Cycle TTL Caching Flow                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Poll Cycle 1:                                                        │
│    1. List all PRs → get updated_at timestamps (1 REST call)            │
│    2. Batch fetch ALL PRs via GraphQL                                  │
│    3. Cache with lastFetched timestamp + updatedAt                           │
│                                                                     │
│  Poll Cycle 2:                                                        │
│    1. List all PRs → get updated_at timestamps (1 REST call)            │
│    2. Compare with cached updatedAt                                             │
│    3. Only fetch PRs that changed via GraphQL                               │
│    4. Update lastFetched timestamp                                        │
│                                                                     │
│  Poll Cycle 3+: Similar to Cycle 2...                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation

#### Type Definitions

```typescript
// packages/core/src/types.ts

export interface CachedPREnrichment {
  data: PREnrichmentData;
  lastFetched: number;      // Unix timestamp when cached
  updatedAt: string;        // GitHub's PR.updated_at
}

export interface SCM {
  // ... existing methods ...

  /** Fetch updated_at timestamps for multiple PRs in one REST call */
  getPRListTimestamps?(prs: PRInfo[]): Promise<Map<string, string>>;
}
```

#### Core Changes to lifecycle-manager.ts

```typescript
// Replace existing single-cycle cache with persistent TTL cache
const prEnrichmentCache = new Map<string, CachedPREnrichment>();

async function populatePREnrichmentCacheWithTTL(
  sessions: Session[],
  options: { ttlMs?: number } = {}
): Promise<void> {
  const { ttlMs = 120_000 } = options; // Default 2 minutes

  // 1. Collect unique PRs
  const prs = sessions
    .map((s) => s.pr)
    .filter((pr): pr is NonNullable<typeof pr> => pr !== null);

  const uniquePRs = Array.from(
    new Map(prs.map((pr) => [`${pr.owner}/${pr.repo}#${pr.number}`, pr])).values(),
  );

  if (uniquePRs.length === 0) return;

  // 2. Group by plugin
  const prsByPlugin = new Map<string, typeof uniquePRs>();
  for (const pr of uniquePRs) {
    const project = Object.values(config.projects).find((p) => {
      const [owner, repo] = p.repo.split("/");
      return owner === pr.owner && repo === pr.repo;
    });
    if (!project?.scm) continue;

    const pluginKey = project.scm.plugin;
    if (!prsByPlugin.has(pluginKey)) prsByPlugin.set(pluginKey, []);
    prsByPlugin.get(pluginKey)!.push(pr);
  }

  // 3. Fetch updated_at timestamps (1 REST call per repo)
  const changedPRsByPlugin = new Map<string, typeof uniquePRs>();
  const now = Date.now();

  for (const [pluginKey, pluginPRs] of prsByPlugin) {
    const scm = registry.get<SCM>("scm", pluginKey);
    if (!scm?.getPRListTimestamps) {
      // Fallback: fetch all if method not available
      changedPRsByPlugin.set(pluginKey, pluginPRs);
      continue;
    }

    const timestamps = await scm.getPRListTimestamps(pluginPRs);
    const pluginChangedPRs: typeof uniquePRs = [];

    for (const pr of pluginPRs) {
      const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
      const cached = prEnrichmentCache.get(prKey);
      const remoteUpdatedAt = timestamps.get(prKey);

      const needsRefresh =
        !cached ||                              // First time seeing this PR
        now - cached.lastFetched > ttlMs ||  // TTL expired
        (remoteUpdatedAt && remoteUpdatedAt !== cached.updatedAt); // PR was updated

      if (needsRefresh) {
        pluginChangedPRs.push(pr);
      }
    }

    if (pluginChangedPRs.length > 0) {
      changedPRsByPlugin.set(pluginKey, pluginChangedPRs);
    }
  }

  // 4. Batch fetch only changed PRs
  for (const [pluginKey, changedPRs] of changedPRsByPlugin) {
    const scm = registry.get<SCM>("scm", pluginKey);
    if (!scm?.enrichSessionsPRBatch) continue;

    const enrichmentData = await scm.enrichSessionsPRBatch(changedPRs);
    for (const [key, data] of enrichmentData) {
      prEnrichmentCache.set(key, {
        data,
        lastFetched: now,
        updatedAt: data.updatedAt || extractUpdatedAt(data),
      });
    }
  }

  // 5. Prune old cache entries
  const maxCacheAge = ttlMs * 5; // Keep for 5x TTL
  for (const [key, entry] of prEnrichmentCache) {
    if (now - entry.lastFetched > maxCacheAge) {
      prEnrichmentCache.delete(key);
    }
  }
}
```

#### GitHub Plugin Implementation

```typescript
// packages/plugins/scm-github/src/index.ts

async getPRListTimestamps(prs: PRInfo[]): Promise<Map<string, string>> {
  // Group by repo to minimize calls
  const reposToFetch = new Map<string, PRInfo[]>();
  for (const pr of prs) {
    const repoKey = `${pr.owner}/${pr.repo}`;
    if (!reposToFetch.has(repoKey)) reposToFetch.set(repoKey, []);
    reposToFetch.get(repoKey)!.push(pr);
  }

  const result = new Map<string, string>();

  for (const [repoKey, repoPRs] of reposToFetch) {
    // Single REST call gets ALL PRs with updated_at
    const raw = await gh([
      "pr",
      "list",
      "--repo", repoKey,
      "--state", "open",
      "--limit", "100", // Get all open PRs
      "--json", "number,updated_at",
      "--sort", "updated",
    ]);

    const prList: Array<{ number: number; updated_at: string }> = JSON.parse(raw);

    // Build lookup map
    const repoUpdates = new Map(prList.map(pr => [pr.number, pr.updated_at]));

    // Map back to requested PRs
    for (const pr of repoPRs) {
      const updated = repoUpdates.get(pr.number);
      if (updated) {
        result.set(`${pr.owner}/${pr.repo}#${pr.number}`, updated);
      }
    }
  }

  return result;
}
```

### Cost Analysis

| Metric | Without TTL | With TTL (120s, avg 10% change) |
|---------|--------------|------------------------------------|
| REST list calls | 0 | 120/hour (2.4% of Core API) |
| GraphQL polls | All PRs every poll | Only changed PRs (~10% of total) |
| GraphQL points/hour (100 PRs) | ~48,000 | ~4,800 |
| **Savings** | — | **90% reduction** |

### When PR updated_at Updates

| Event | Updates PR.updated_at? | Does TTL catch it? |
|--------|------------------------|---------------------|
| Title/description change | ✅ Yes | ✅ Yes |
| New commits pushed | ✅ Yes | ✅ Yes |
| PR merged/closed | ✅ Yes | ✅ Yes |
| Review submitted | ✅ Yes | ✅ Yes |
| **CI check status change** | ❌ **No** | ❌ **No** - CRITICAL |
| Review comment added | ❌ No | N/A |
| New PR comment | ❌ No | N/A |
| Labels added/removed | ✅ Yes | ✅ Yes |
| Assignee changed | ✅ Yes | ✅ Yes |
| Draft status toggle | ✅ Yes | ✅ Yes |

**CRITICAL ISSUE:** CI status changes do NOT update `updated_at`. A PR could have CI fail for 10 minutes but `updated_at` stays the same.

### Enhanced TTL with CI State Tracking

```typescript
interface CachedPREnrichment {
  data: PREnrichmentData;
  lastFetched: number;
  prUpdatedAt: string;      // From PR.updated_at
  lastCIStatus?: CIStatus;   // Track CI state separately
}

function needsRefresh(
  cached: CachedPREnrichment,
  remoteUpdatedAt: string,
  remoteCIStatus?: CIStatus,
  ttlMs: number
): boolean {
  const now = Date.now();

  // Always refresh if TTL exceeded
  if (now - cached.lastFetched > ttlMs) return true;

  // Refresh if PR was updated
  if (remoteUpdatedAt !== cached.prUpdatedAt) return true;

  // Refresh if CI status changed (CRITICAL - addresses updated_at issue!)
  if (remoteCIStatus && remoteCIStatus !== cached.lastCIStatus) {
    return true;
  }

  return false;
}
```

### Capacity with TTL Caching

| Total PRs | Avg Changed/Poll | Poll Interval | Core API/hr | GraphQL/hr | Headroom |
|------------|-------------------|----------------|--------------|-----------|
| 50 | 3-5 | 30s | 120 | 1,200-2,000 | 60-76% ✅ |
| 100 | 5-8 | 30s | 120 | 2,000-3,200 | 36-64% ✅ |
| 200 | 8-12 | 45s | 80 | 2,100-4,200 | 16-58% ✅ |
| 500 | 15-20 | 60s | 60 | 3,600-4,800 | 4-36% ✅ |

**Max PRs at 30s polling:** ~150-200 PRs with TTL (vs ~35 currently)

---

## Approach 2: GraphQL Query Cost Optimization

### Concept

Reduce GraphQL points by removing the expensive `contexts(first: 100)` field. Use only the top-level `statusCheckRollup.state` for aggregate status.

### Cost Impact

| PRs | With contexts(first: 100) | Rollup state only | Savings |
|------|---------------------------|-----------------|----------|
| 1 PR | ~40 points | ~10 points | 75% |
| 5 PRs | ~200 points | ~50 points | 75% |
| 10 PRs | ~400 points | ~100 points | 75% |
| 25 PRs | ~1,000 points | ~250 points | 75% |
| 100 PRs | ~4,000 points | ~1,000 points | 75% |

### Implementation

```typescript
// packages/plugins/scm-github/src/graphql-batch.ts

// BEFORE (expensive - ~100 points per PR)
const PR_FIELDS_EXPENSIVE = `
  ...
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 100) {  // ← COSTLY: ~100 points
            nodes {
              ... on CheckRun { name, status, conclusion }
              ... on StatusContext { context, state }
            }
          }
        }
      }
    }
  }
`;

// AFTER (optimized - ~10-15 points per PR)
const PR_FIELDS_OPTIMIZED = `
  ...
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state  // ← Just rollup state: SUCCESS/FAILURE/PENDING
        }
      }
    }
  }
`;

// ALTERNATIVE: Keep some contexts but limit to 10
const PR_FIELDS_LIMITED = `
  ...
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 10) {  // ← Reduced from 100
            nodes {
              ... on CheckRun { name, status, conclusion }
              ... on StatusContext { context, state }
            }
          }
        }
      }
    }
  }
`;
```

### Trade-offs

| Approach | Points/PR | Pros | Cons |
|----------|------------|-------|-------|
| Rollup state only | ~10 | Maximum savings | None for current use case |
| contexts(first: 10) | ~20 | Still get some check names | Higher points than rollup only |
| contexts(first: 100) | ~40 | Get all check names | Expensive |

**Recommendation:** Use rollup state only. The polling loop only needs aggregate status, not individual check names.

---

## Approach 3: Adaptive Polling Frequency

### Concept

Poll active PRs (CI pending, review required, conflicts) more frequently. Back off for idle PRs that haven't changed recently.

### Implementation

```typescript
// packages/core/src/lifecycle-manager.ts

interface PRPollingState {
  lastActivityTime: number;
  consecutiveIdlePolls: number;
}

const prPollingState = new Map<string, PRPollingState>();

function getPollIntervalForPR(
  prKey: string,
  cachedData?: CachedPREnrichment
): number {
  if (!cachedData) return 30_000; // Default 30s for unknown PRs

  const state = prPollingState.get(prKey);
  const now = Date.now();
  const timeSinceActivity = state ? now - state.lastActivityTime : 0;

  // PRs with CI pending or review required: poll fast
  if (
    cachedData.data.ciStatus === "pending" ||
    cachedData.data.reviewDecision === "pending" ||
    (cachedData.data.mergeable === false && cachedData.data.ciStatus === "passing")
  ) {
    return 30_000; // 30s - keep responsive
  }

  // PRs that haven't changed recently: back off
  if (timeSinceActivity > 300_000) { // 5+ minutes idle
    return 120_000; // 2 min for stale PRs
  }

  if (timeSinceActivity > 600_000) { // 10+ minutes idle
    return 300_000; // 5 min for very stale PRs
  }

  return 60_000; // Default 1 min
}

async function populatePREnrichmentCacheAdaptive(sessions: Session[]): Promise<void> {
  // ... collect PRs ...

  // Group PRs by their desired poll interval
  const prsByInterval = new Map<number, typeof uniquePRs>();
  const now = Date.now();

  for (const pr of uniquePRs) {
    const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
    const cached = prEnrichmentCache.get(prKey);
    const interval = getPollIntervalForPR(prKey, cached);
    const lastFetch = prPollingState.get(prKey)?.lastActivityTime || 0;

    if (now - lastFetch >= interval) {
      if (!prsByInterval.has(interval)) prsByInterval.set(interval, []);
      prsByInterval.get(interval)!.push(pr);
    }
  }

  // Fetch each group
  for (const [interval, intervalPRs] of prsByInterval) {
    if (intervalPRs.length > 0) {
      await enrichSessionsPRBatch(intervalPRs);

      // Update last activity times
      for (const pr of intervalPRs) {
        const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
        prPollingState.set(prKey, {
          lastActivityTime: now,
          consecutiveIdlePolls: 0,
        });
      }
    }
  }
}
```

### Impact Analysis

| PR Category | Interval | % of PRs | Polls/Hour |
|-------------|-----------|------------|--------------|
| Active (CI pending, review needed, conflicts) | 30s | 15% | 18 |
| Normal | 60s | 50% | 30 |
| Stale (>5 min idle) | 120s | 25% | 15 |
| Very stale (>10 min idle) | 300s | 10% | 6 |

**Effective poll rate:** ~69 polls/hour vs 120 (43% reduction in total polls)

---

## Approach 4: Hybrid REST + GraphQL

### Concept

Use Core API (3 points = complete data) for most PRs. Only use GraphQL as overflow when approaching rate limit.

### Implementation

```typescript
// packages/plugins/scm-github/src/index.ts

async enrichSessionsPRHybrid(
  prs: PRInfo[],
  options: { maxCoreAPICalls?: number } = {}
): Promise<Map<string, PREnrichmentData>> {
  const maxCoreCalls = options.maxCoreAPICalls ?? 100; // Leave 100 buffer

  const result = new Map<string, PREnrichmentData>();

  if (prs.length <= maxCoreCalls) {
    // Use REST - cheaper per PR (3 points vs 40 points GraphQL)
    for (const pr of prs) {
      const [state, ciStatus, reviewDecision, mergeReady] = await Promise.all([
        this.getPRState(pr),        // 1 point
        this.getCISummary(pr),       // 1 point
        this.getReviewDecision(pr),  // 1 point
        this.getMergeability(pr),      // 1 point (uses previous results)
      ]);

      result.set(`${pr.owner}/${pr.repo}#${pr.number}`, {
        state,
        ciStatus,
        reviewDecision,
        mergeable: mergeReady.mergeable,
        blockers: mergeReady.blockers,
        title: mergeReady.title,
        additions: mergeReady.additions,
        deletions: mergeReady.deletions,
      });
    }
  } else {
    // Use GraphQL batch for overflow
    return this.enrichSessionsPRBatch(prs);
  }

  return result;
}
```

### Cost Comparison

| PRs | REST Only | GraphQL Only | Hybrid (100 REST + rest GraphQL) |
|------|------------|---------------|--------------------------------|
| 50 | 600 pts | 2,000 pts | 300 REST + 500 GraphQL = 800 pts |
| 100 | 1,200 pts | 4,000 pts | 300 REST + 1,500 GraphQL = 1,800 pts |
| 200 | N/A | N/A | 300 REST + 3,000 GraphQL = 3,300 pts |

---

## Approach 5: ETag / Conditional Requests

### Concept

GitHub returns `304 Not Modified` without counting against rate limits when using `If-None-Match` header with ETag.

### Limitations

1. **gh CLI doesn't expose ETag headers** - Requires direct HTTP calls
2. **Only works for individual resource endpoints** - Not for batch queries
3. **Limited benefit** - Only saves points when content hasn't changed

### Implementation (Direct HTTP)

```typescript
interface ETagCache {
  etag: string;
  lastFetched: number;
  cachedData: PREnrichmentData;
}

const prETagCache = new Map<string, ETagCache>();

async function getPRStateWithETag(pr: PRInfo): Promise<PRState> {
  const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
  const cached = prETagCache.get(prKey);

  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
  };

  if (cached) {
    headers["If-None-Match"] = cached.etag;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
      { headers }
    );

    if (response.status === 304) {
      // Not modified - use cached
      return parsePRState(cached.cachedData.state);
    }

    const data = await response.json();
    const etag = response.headers.get("etag") || "";

    const enriched = extractPREnrichment(data);

    prETagCache.set(prKey, {
      etag,
      lastFetched: Date.now(),
      cachedData: enriched,
    });

    return enriched.state;
  } catch (err) {
    // Fallback to regular method
    return this.getPRState(pr);
  }
}
```

---

## Recommended Solution

### Combined Approach: TTL + Query Optimization + CI State Tracking

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              Recommended Architecture for 100+ Parallel Sessions        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. Cross-cycle TTL cache (120s default)                                 │
│     • Persist cache across polls                                           │
│     • Track both PR.updated_at AND CI status                                 │
│                                                                     │
│  2. Lightweight change detection (1 REST call/poll)                         │
│     • GET /repos/{owner}/{repo}/pulls?state=open&sort=updated             │
│     • Returns updated_at for ALL open PRs                               │
│     • Compare against cache timestamps                                          │
│                                                                     │
│  3. Optimized GraphQL queries                                                  │
│     • Drop contexts(first: 100) - use rollup state only (~75% savings)     │
│     • Only fetch changed PRs                                               │
│                                                                     │
│  4. Optional adaptive polling                                                   │
│     • 30s for active PRs                                               │
│     • 60-120s for stale PRs                                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Expected Capacity

| Parallel Sessions | Poll Interval | Avg Changed/Poll | Core API/hr | GraphQL/hr | Total % of Limit |
|------------------|----------------|-------------------|--------------|---------------------|
| 35 | 60s | 3-5 | 40 | 600-900 | 12-18% ✅ |
| 50 | 60s | 3-5 | 40 | 600-900 | 12-18% ✅ |
| 100 | 60s | 5-8 | 40 | 600-1,200 | 12-24% ✅ |
| 100 | 60s (no contexts) | 5-8 | 40 | 300-600 | 6-12% ✅ |
| 200 | 90s | 8-12 | 27 | 800-1,200 | 16-24% ✅ |

**With full optimization, you can handle 100+ parallel sessions at 60s polling with ample headroom.**

---

## Implementation Roadmap

### Phase 1: Cross-Cycle TTL Caching (Priority: HIGH)

**Files to modify:**
- `packages/core/src/types.ts` - Add `CachedPREnrichment` interface
- `packages/core/src/types.ts` - Add `getPRListTimestamps()` to SCM interface
- `packages/core/src/lifecycle-manager.ts` - Replace `prEnrichmentCache` with TTL cache
- `packages/plugins/scm-github/src/index.ts` - Implement `getPRListTimestamps()`

**Estimated effort:** 2-3 hours

**Expected impact:** ~90% reduction in GraphQL points

### Phase 2: Query Cost Optimization (Priority: HIGH)

**Files to modify:**
- `packages/plugins/scm-github/src/graphql-batch.ts` - Update `PR_FIELDS` constant

**Estimated effort:** 30 minutes

**Expected impact:** Additional ~75% reduction in GraphQL points per query

### Phase 3: CI State Tracking (Priority: MEDIUM)

**Files to modify:**
- `packages/plugins/scm-github/src/graphql-batch.ts` - Track CI status in cache
- `packages/core/src/lifecycle-manager.ts` - Update TTL logic

**Estimated effort:** 1 hour

**Expected impact:** Addresses `updated_at` not updating on CI changes

### Phase 4: Adaptive Polling (Priority: LOW - Optional Enhancement)

**Files to modify:**
- `packages/core/src/lifecycle-manager.ts` - Add adaptive interval logic

**Estimated effort:** 1-2 hours

**Expected impact:** Additional ~30-40% reduction in total polls

---

## Summary

| Approach | Implementation Effort | GraphQL Savings | Max PRs (60s poll) | Prerequisite |
|----------|---------------------|------------------|---------------------|---------------|
| TTL Caching | 2-3 hours | ~90% | ~150-200 | None |
| Query Optimization | 30 min | ~75% | ~200-250 | None |
| CI State Tracking | 1 hour | N/A | Addresses CI staleness | TTL Caching |
| Adaptive Polling | 1-2 hours | ~40% | ~200-250 | TTL Caching |
| Combined (All) | 4-6 hours | ~95% total | **200-250** | None |

**Answer to "Can we drop contexts?": YES, absolutely. The UI individual check names come from a separate REST endpoint (`getCIChecks()`), so removing `contexts(first: 100)` from the polling GraphQL query loses no functionality while saving ~75% in GraphQL points.**
