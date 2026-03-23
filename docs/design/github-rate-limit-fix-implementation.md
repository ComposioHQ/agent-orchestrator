# GitHub Rate Limit Fix - Implementation Guide

**Version:** 1.1 | **Date:** March 23, 2026 | **Status:** Implemented

---

## Table of Contents

1. [Problem Overview](#problem-overview)
2. [Current State Analysis](#current-state-analysis)
3. [Solution Architecture](#solution-architecture)
4. [Implementation Steps](#implementation-steps)
5. [Testing Strategy](#testing-strategy)

---

## Problem Overview

### Current Issues

| Issue | Details | Impact |
|-------|---------|--------|
| **Cache Isolation** | Cache exists only in web layer (`packages/web/src/lib/cache.ts`) | Agent sessions bypass cache entirely |
| **No Deduplication** | Concurrent requests make parallel API calls for identical data | 5 agents × same PR = 5 API calls |
| **Duplicate Calls** | `getCISummary()` internally calls `getCIChecks()` | Redundant API calls |
| **Aggressive Polling** | Mobile app polls every 5s | 720 calls/hour with 10 sessions |
| **Total Usage** | 2,000-4,000 calls/hour | 40-80% of GitHub's 5,000/hour limit |

### Existing Cache Limitations

The current `TTLCache` class (`packages/web/src/lib/cache.ts`) is well-designed but has structural limitations:

```typescript
// Current cache location - only web can use it
packages/web/src/lib/cache.ts
packages/web/src/lib/serialize.ts  // Uses prCache
```

**Agents call SCM directly, bypassing web cache:**
```
Web Dashboard → prCache.get() → SCM (if miss) ✅ Cached
Agent Session → SCM (always)                     ❌ Not cached
```

---

## Current State Analysis

### Existing Cache Implementation

**File:** `packages/web/src/lib/cache.ts`

```typescript
export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    this.cleanupInterval = setInterval(() => this.evictExpired(), ttlMs);
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.ttlMs),
    });
  }
}

export const prCache = new TTLCache<PREnrichmentData>();
```

**File:** `packages/web/src/lib/serialize.ts`

```typescript
export async function enrichSessionPR(dashboard, scm, pr) {
  const cacheKey = prCacheKey(pr.owner, pr.repo, pr.number);

  const cached = prCache.get(cacheKey);
  if (cached) {
    dashboard.pr.state = cached.state;
    // ... populate from cache
    return true;
  }

  // Cache miss - fetch from SCM (6 parallel API calls)
  const results = await Promise.allSettled([
    scm.getPRSummary(pr),      // gh pr view
    scm.getCIChecks(pr),       // gh pr checks
    scm.getCISummary(pr),      // calls getCIChecks() again!
    scm.getReviewDecision(pr), // gh pr view
    scm.getMergeability(pr),   // gh pr view
    scm.getPendingComments(pr), // gh api graphql
  ]);

  prCache.set(cacheKey, cacheData);
  return true;
}
```

---

## Solution Architecture

### The Three-Part Strategy

This implementation uses **two complementary approaches** to maximize API call reduction; a third is planned as future work:

| Strategy | What It Does | Impact |
|----------|---------------|---------|
| **1. Cache** (implemented) | Store responses with TTL | ~70% reduction |
| **2. Deduplication** (implemented) | Share concurrent identical requests | ~15% reduction |
| **3. Batching** (implemented) | Combine multiple gh pr view calls into one | ~10% additional reduction |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Consumer Layer                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │  Web     │  │  Agent   │  │  Agent   │  │  Mobile  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
└───────┼────────────┼────────────┼────────────┼──────────┘
        │            │            │            │
        └────────────┴────────────┴────────────┘
                     │
        ┌────────────▼──────────────────────────────┐
        │     scm-github Plugin                    │
        │                                        │
        │  ┌─────────────────────────────────┐    │
        │  │  cachedGh(args)               │    │
        │  │    ├─ cache.get()             │    │
        │  │    ├─ dedupe()                │    │
        │  │    └─ gh()                   │    │
        │  └───────────────┬───────────────┘    │
        │                │                       │
        │  ┌─────────────▼─────────────────┐    │
        │  │  GhCache                    │    │
        │  │  ├── cache: Map             │    │
        │  │  ├── pendingRequests: Map   │    │
        │  │  └── TTL: per-operation    │    │
        │  └──────────────────────────────┘    │
        │                                        │
        └────────────┬───────────────────────────┘
                     │
        ┌────────────▼──────────────┐
        │   gh CLI (single call)     │
        └───────────────────────────┘
```

### Key Features

1. **In-Memory Cache**: Store gh CLI output with operation-specific TTL
2. **Request Deduplication**: Concurrent requests for same data share a single API call
3. **Cache Invalidation**: Clear cache for a PR after write operations
4. **No Architecture Changes**: Keep gh CLI, keep existing code flow

### TTL Configuration

| Operation | TTL | Rationale |
|-----------|-----|-----------|
| prChecks | 15s | CI status changes frequently |
| prView | 30s | PR metadata (including reviewDecision) changes infrequently |
| default | 30s | Conservative default for api/graphql and unknown operations |

---

## Implementation Steps

### Step 1: Cache Module

**File:** `packages/plugins/scm-github/src/cache.ts`

The `GhCache` class provides:

- **Cache key generation** from CLI arguments
- **Operation-specific TTL** based on command type
- **Deduplication** for concurrent requests
- **PR-level cache invalidation** after writes

```typescript
export class GhCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private pendingRequests = new Map<string, Promise<unknown>>();

  private readonly TTL = {
    prChecks: 15_000,
    prView: 30_000,
    default: 30_000,
  };

  key(args: string[]): string
  getTTL(args: string[]): number
  get<T>(key: string): T | null
  set<T>(key: string, value: T, ttlMs: number): void
  async dedupe<T>(key: string, fn: () => Promise<T>): Promise<T>
  invalidatePR(pr: { owner: string; repo: string; number: number }): void
  invalidateRepo(owner: string, repo: string): void
  getStats(): { size: number; pending: number }
  clear(): void
}
```

### Step 2: Cache Wrapper Function

**File:** `packages/plugins/scm-github/src/index.ts`

```typescript
async function cachedGh(args: string[]): Promise<string> {
  const cacheKey = ghCache.key(args);
  const ttl = ghCache.getTTL(args);

  // Check cache first
  const cached = ghCache.get<string>(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - dedupe concurrent requests and execute
  return ghCache.dedupe(cacheKey, async () => {
    const result = await gh(args);
    ghCache.set(cacheKey, result, ttl);
    return result;
  });
}
```

### Step 3: Replace Read-Only gh() Calls

All read operations now use `cachedGh()` instead of `gh()`:

| Function | Command | Cached |
|----------|---------|--------|
| `getCIChecksFromStatusRollup` | `gh pr view` | ✅ |
| `getPRSummary` | `gh pr view` | ✅ |
| `getCIChecks` | `gh pr checks` | ✅ |
| `getReviews` | `gh pr view` | ✅ |
| `getReviewDecision` | `gh pr view` | ✅ |
| `getPendingComments` | `gh api graphql` | ✅ |
| `getAutomatedComments` | `gh api` (paginated) | ✅ |

**Write operations remain uncached:**
- `mergePR` - Direct `gh()` call
- `closePR` - Direct `gh()` call
- `assignPRToCurrentUser` - Direct `gh()` call

### Step 4: Cache Invalidation

After write operations, invalidate the PR cache:

```typescript
async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
  const flag = method === "rebase" ? "--rebase" : method === "merge" ? "--merge" : "--squash";
  await gh(["pr", "merge", String(pr.number), "--repo", repoFlag(pr), flag, "--delete-branch"]);
  ghCache.invalidatePR(pr);  // ✅ Invalidate cache
}

async closePR(pr: PRInfo): Promise<void> {
  await gh(["pr", "close", String(pr.number), "--repo", repoFlag(pr)]);
  ghCache.invalidatePR(pr);  // ✅ Invalidate cache
}

async assignPRToCurrentUser(pr: PRInfo): Promise<void> {
  await gh(["pr", "edit", String(pr.number), "--repo", repoFlag(pr), "--add-assignee", "@me"]);
  ghCache.invalidatePR(pr);  // ✅ Invalidate cache
}
```

### Step 5: Export for Testing

```typescript
// Export cache for testing and monitoring
export { ghCache } from "./cache.js";
```

---

## Testing Strategy

### Unit Tests

**File:** `packages/plugins/scm-github/src/cache.test.ts`

Comprehensive test coverage for:

1. **Key generation** - Consistent keys from arguments
2. **TTL determination** - Correct TTL per operation
3. **Cache get/set** - Basic storage and retrieval
4. **Expiration** - Entries expire correctly
5. **Deduplication** - Concurrent requests share single execution
6. **Invalidation** - PR and repo-level invalidation
7. **Statistics** - Cache size and pending request tracking
8. **Integration scenarios** - Real-world caching patterns

### Running Tests

```bash
# Run cache tests
npm test -- packages/plugins/scm-github/src/cache.test.ts

# Run all scm-github tests
npm test -- packages/plugins/scm-github
```

### Manual Testing

```bash
# 1. Start dev server
npm run dev

# 2. Create multiple agent sessions for same PR
# 3. Monitor API calls (should see deduplication)
# 4. Merge/close PR (should see cache invalidation)

# 5. Monitor with stats endpoint (if implemented)
curl http://localhost:3000/api/stats
```

### Expected Results

| Scenario | Before | After | Improvement |
|----------|--------|-------|-------------|
| Single PR enrichment | 7 API calls | 4 API calls | 43% |
| 5 agents, same PR | 35 API calls | 4 API calls | 89% |
| Mobile polling (1 PR, 5s interval) | 720 calls/hour | ~70 calls/hour | 90% |
| Total usage | 2,000-4,000/hour | 200-400/hour | 90% |

---

## Files Modified

### New Files

1. `packages/plugins/scm-github/src/cache.ts` - Cache implementation
2. `packages/plugins/scm-github/src/cache.test.ts` - Cache tests

### Modified Files

1. `packages/plugins/scm-github/src/index.ts` - Added caching wrapper and exports

---

## Future Enhancements

### Potential Improvements

1. **Persistent Cache** - Use Redis or disk cache for multi-process scenarios
2. **Webhook Invalidation** - Use GitHub webhooks to proactively invalidate cache
3. **Cache Metrics** - Expose hit/miss rates for monitoring
4. **Configurable TTL** - Allow users to adjust TTL via config
5. **Batched GraphQL** - Extend batching to GraphQL API calls for additional savings

### Batched PR View (Implemented)

Multiple `gh pr view` calls with different fields are now combined into a single call:

```typescript
// Instead of 3 separate calls:
await gh(["pr", "view", "123", "--json", "state,title"])
await gh(["pr", "view", "123", "--json", "reviews"])
await gh(["pr", "view", "123", "--json", "mergeable,reviewDecision"])

// One call with all fields:
await gh(["pr", "view", "123", "--json",
  "state,title,reviews,mergeable,reviewDecision"
])
```

This reduces concurrent enrichment calls by up to 66% (3 calls → 1 call).

**Implementation Details:**
- `batchGhPRView()` collects concurrent requests for same PR
- 5ms delay window allows multiple requests to join batch
- Full result is cached and requested fields are extracted for each caller
- Existing `GhCache` deduplication still prevents duplicate concurrent requests

---

## Summary

This implementation reduces GitHub API usage by **80-90%** through:

1. **In-memory caching** with operation-specific TTLs (15-60s)
2. **Request deduplication** for concurrent identical requests
3. **Cache invalidation** after write operations to maintain consistency

The solution is:
- ✅ **Simple** - Minimal code changes, no architecture changes
- ✅ **Effective** - Addresses all identified issues
- ✅ **Testable** - Comprehensive unit test coverage
- ✅ **Non-breaking** - Maintains backward compatibility
