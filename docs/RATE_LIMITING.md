# Rate Limit Handling Architecture

**Status**: Implemented
**Issue**: INT-1370
**Date**: 2026-02-16

## Problem Statement

The dashboard was hitting GitHub API rate limits when loading, causing:
- GraphQL API exhaustion (5001/5000 requests)
- Dashboard fetching PR data for all sessions on every page load
- No caching, batch fetching 20+ sessions simultaneously
- Silent failures showing wrong/stale data instead of explicit errors

## Goals

Design a **plugin-agnostic architecture** that:
1. Prevents rate limit exhaustion (caching, lazy loading)
2. Shows explicit rate limit messages when limits are hit
3. Works for any plugin (GitHub, GitLab, Linear, Jira, Bitbucket, etc.)
4. Transparent UX - users know when viewing cached vs fresh vs rate-limited data

## Architecture

### 1. Core Types

New types in `packages/core/src/types.ts`:

#### `RateLimitInfo`
```typescript
export interface RateLimitInfo {
  /** Quota name (e.g., "graphql", "rest", "search", "core") */
  resource: string;
  /** Remaining calls before limit */
  remaining: number;
  /** Total limit */
  limit: number;
  /** When the limit resets (UTC) */
  resetAt: Date;
  /** Whether currently rate limited (remaining === 0) */
  isLimited: boolean;
}
```

#### `RateLimitError`
```typescript
export class RateLimitError extends Error {
  readonly code = "RATE_LIMIT_EXCEEDED" as const;
  readonly resource: string;
  readonly resetAt: Date;
  readonly retryAfter: number; // seconds until reset

  constructor(resource: string, resetAt: Date, options?: { cause?: Error })
}
```

**Usage**: Plugins throw `RateLimitError` when hitting limits. Core services and dashboard catch it and display structured error information.

### 2. Plugin Interface Extensions

Added optional `getRateLimitStatus()` method to `SCM` and `Tracker` interfaces:

```typescript
export interface SCM {
  // ... existing methods ...

  /** Get current rate limit status (optional, for plugins that track quotas) */
  getRateLimitStatus?(): Promise<RateLimitInfo[]>;
}

export interface Tracker {
  // ... existing methods ...

  /** Optional: get current rate limit status */
  getRateLimitStatus?(): Promise<RateLimitInfo[]>;
}
```

**Returns**: Array of `RateLimitInfo` objects (one per resource/quota type).
**Example**: GitHub returns 3 resources: `core` (REST), `graphql`, `search`.

### 3. Cache Architecture

#### TTL Cache with Metadata

Enhanced `TTLCache` in `packages/web/src/lib/cache.ts`:

```typescript
interface CacheEntry<T> {
  value: T;
  cachedAt: number;  // NEW: when data was cached
  expiresAt: number; // when cache expires
}

export interface CachedValue<T> {
  value: T;
  cachedAt: Date;
  ageMs: number;     // milliseconds since cached
  ttlMs: number;     // total TTL
  stale: boolean;    // whether >75% of TTL has elapsed
}
```

**Methods**:
- `get(key)` - Returns value only (backwards compatible)
- `getWithMetadata(key)` - Returns `CachedValue<T>` with age and staleness

**TTL**: Default 60 seconds (configurable per cache instance)

#### Cache Transparency

Dashboard types in `packages/web/src/lib/types.ts`:

```typescript
export interface DashboardPR {
  // ... existing fields ...

  // Cache metadata (for transparency UX)
  cacheAge?: number;      // milliseconds since data was cached
  lastFetched?: string;   // ISO timestamp when data was last fetched
  stale?: boolean;        // whether cache is nearing expiry (>75% of TTL)

  // Rate limit status (if plugin was rate limited)
  rateLimitStatus?: {
    isLimited: boolean;
    resetAt?: string;     // ISO timestamp
    retryAfter?: number;  // seconds until reset
  };
}
```

**UX**: Dashboard can show "Updated 2m ago" indicators and gray out stale data.

### 4. Error Handling Strategy

#### Fail-Safe Partial Data

In `enrichSessionPR()` (serialize.ts):
1. Attempt 6 parallel API calls: `getPRSummary`, `getCIChecks`, `getCISummary`, `getReviewDecision`, `getMergeability`, `getPendingComments`
2. Use `Promise.allSettled()` - apply successful results even if some fail
3. Detect rate limiting: if ≥50% of calls fail, mark as rate limited
4. Cache partial data to reduce future API pressure
5. Add explicit blocker: "API rate limited or unavailable"

**Benefits**:
- Dashboard doesn't break completely when rate limited
- Users see partial data + clear error message
- Cache reduces subsequent load during rate limit period

### 5. GitHub SCM Plugin Implementation

Added `getRateLimitStatus()` in `packages/plugins/scm-github/src/index.ts`:

```typescript
async getRateLimitStatus(): Promise<RateLimitInfo[]> {
  const raw = await gh(["api", "rate_limit"]);
  const data = JSON.parse(raw);

  return [
    {
      resource: "core",
      remaining: data.resources.core.remaining,
      limit: data.resources.core.limit,
      resetAt: new Date(data.resources.core.reset * 1000),
      isLimited: data.resources.core.remaining === 0,
    },
    // ... graphql, search
  ];
}
```

**Returns**: 3 resources (core, graphql, search) with remaining quota and reset times.

## UX Patterns

### Cache Age Indicators

When showing cached data:
```
Updated 2m ago
Last fetched at 10:32 AM
```

Show staleness:
- Green: < 30s (fresh)
- Yellow: 30-45s (stale)
- Gray: > 45s (very stale)

### Rate Limit Messages

When rate limited:
```
⚠️ GitHub API rate limited
Resets at 4:35 AM (in 17 minutes)
```

**Dashboard-wide banner**: If any plugin is rate limited, show banner with:
- Which plugin (GitHub, Linear, etc.)
- Reset time
- Retry after duration

**Per-card indicator**: Show warning icon on PR cards affected by rate limits

### Explicit Error States

Never silently show stale data. Always indicate:
1. Data is cached → Show cache age
2. Data is stale → Gray out or add indicator
3. Rate limited → Show banner + reset time
4. No data available → Show empty state with reason

## Future Enhancements

### 1. Lazy Loading

Instead of enriching all PRs on page load, only fetch when:
- Session card is expanded
- User clicks "Details" button
- SSE update triggers refresh for that session

**Benefit**: Reduces initial API load from 20+ sessions to 0-3 visible sessions.

### 2. Request Batching

Batch similar requests:
- Group all `getPRState` calls into one GraphQL query
- Use GitHub's batch API for CI checks
- Debounce rapid requests to same resource

**Benefit**: Reduces total API calls by ~50%.

### 3. Global Quota Manager

Track quota across all plugin instances:
```typescript
export interface QuotaManager {
  track(plugin: string, resource: string, cost: number): void;
  getStatus(plugin: string): RateLimitInfo[];
  isLimited(plugin: string, resource: string): boolean;
}
```

**Benefit**: Proactively prevent rate limits before hitting them.

### 4. Per-Plugin Caching Configuration

Allow per-plugin cache TTL in config:
```yaml
projects:
  my-project:
    scm:
      plugin: github
      cacheTTL: 120000  # 2 minutes
```

**Benefit**: Different APIs have different rate limits - tune accordingly.

### 5. Exponential Backoff

When rate limited, automatically back off with exponential delay:
- 1st retry: 5s
- 2nd retry: 10s
- 3rd retry: 20s
- Wait for resetAt

**Benefit**: Reduces spam during rate limit periods.

## Implementation Checklist

- [x] Add `RateLimitInfo` and `RateLimitError` to core types
- [x] Add `getRateLimitStatus()` to SCM/Tracker interfaces
- [x] Enhance `TTLCache` with metadata (`cachedAt`, `ageMs`, `stale`)
- [x] Add cache transparency fields to `DashboardPR`
- [x] Update `enrichSessionPR()` to use cache metadata
- [x] Implement `getRateLimitStatus()` in GitHub SCM plugin
- [x] Build succeeds with no TypeScript errors
- [ ] Dashboard UI shows cache age indicators
- [ ] Dashboard UI shows rate limit banner
- [ ] Unit tests for `RateLimitError`
- [ ] Unit tests for `TTLCache.getWithMetadata()`
- [ ] Unit tests for `github.getRateLimitStatus()`
- [ ] Integration test simulating rate limit scenario

## Testing Strategy

### Unit Tests

1. **RateLimitError**
   - Constructor creates correct error message
   - `retryAfter` calculates seconds correctly
   - Error is instanceof Error and RateLimitError

2. **TTLCache**
   - `getWithMetadata()` returns correct age
   - `stale` flag is true when >75% of TTL
   - Cache evicts expired entries

3. **GitHub SCM**
   - `getRateLimitStatus()` parses API response correctly
   - Returns 3 resources (core, graphql, search)
   - `isLimited` is true when remaining === 0

### Integration Tests

1. **Rate Limit Simulation**
   - Mock `gh api rate_limit` to return exhausted quota
   - Verify dashboard shows rate limit banner
   - Verify cached data is served
   - Verify error message includes reset time

2. **Cache Behavior**
   - First load: no cache, fetches from API
   - Second load: uses cache, no API calls
   - After TTL: cache expired, fetches again

## References

- **Issue**: INT-1370 - Design plugin-agnostic rate limit handling architecture
- **Related**: INT-1369 - Dashboard PR enrichment rate limiting (immediate fix)
- **GitHub Rate Limit API**: https://docs.github.com/en/rest/rate-limit
- **Linear Rate Limits**: https://developers.linear.app/docs/graphql/working-with-the-graphql-api#rate-limits
