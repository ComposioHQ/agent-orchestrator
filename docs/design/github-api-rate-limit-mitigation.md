# GitHub API Rate Limit Mitigation — Design Document

*Version 1.0 — March 2026*

---

## Problem Statement

The Agent Orchestrator uses the GitHub API extensively through the `gh` CLI tool for:
- **SCM operations** (`scm-github` plugin): PR status, CI checks, reviews, merge readiness
- **Tracker operations** (`tracker-github` plugin): Issue tracking, updates, listing
- **Dashboard enrichment** (`web` package): Real-time PR status for session cards

### GitHub API Rate Limits

| Type | Limit | Context |
|------|-------|----------|
| Authenticated REST API | 5,000 requests/hour | User is logged into `gh` |
| Unauthenticated REST API | 60 requests/hour | No `gh` auth configured |
| GraphQL API | 5,000 points/hour | Different metric (points vs requests) |

### Current API Usage Pattern

Each PR enrichment in the dashboard makes approximately **6 parallel API calls**:

| Method | Purpose |
|---------|---------|
| `getPRSummary()` | PR state, title, diff stats |
| `getCIChecks()` | List all CI check runs |
| `getCISummary()` | Overall CI status (passing/failing) |
| `getReviewDecision()` | Approval status |
| `getMergeability()` | Conflicts, merge state, blockers |
| `getPendingComments()` | Unresolved review threads |

**Impact with N active sessions**: N × 6 requests per dashboard refresh

### Existing Mitigations

1. **TTL Cache** (`packages/web/src/lib/cache.ts`)
   - 5-minute default TTL for PR enrichment data
   - 60-minute TTL when rate-limited detected
   - Issue title cache (5 minutes)

2. **Graceful degradation** (`packages/web/src/lib/serialize.ts`)
   - Uses `Promise.allSettled()` to handle partial failures
   - Adds "API rate limited or unavailable" blocker when most requests fail
   - Returns partial data when some calls succeed

3. **No retry logic** — Failed requests are not retried, only cached longer

---

## Design Goals

1. **Prevent rate limit exhaustion** — Implement proactive throttling, not reactive
2. **Maintain data freshness** — Minimize impact on user experience
3. **Graceful degradation** — Provide useful data even when rate-limited
4. **Cross-plugin coordination** — Centralize rate limit awareness
5. **Observability** — Make rate limit status visible to operators

---

## Proposed Solution

### Overview: Three-Layer Mitigation Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                   Dashboard / CLI Layer                     │
│  (Cache → Enrich → Render)                              │
└─────────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              GitHub API Client Layer (New)                   │
│  - Request queue & throttling                               │
│  - Rate limit tracking                                       │
│  - Automatic retry with exponential backoff                    │
│  - GraphQL query consolidation                               │
└─────────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                   gh CLI (Existing)                       │
│  - REST API calls                                          │
│  - GraphQL queries                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component 1: GitHub API Client Wrapper

### File: `packages/core/src/github-client.ts`

Create a new module that wraps `gh` CLI calls with rate limit awareness.

```typescript
interface GitHubRateLimit {
  remaining: number;
  resetAt: Date;
  limit: number;
  used: number;
}

interface GitHubRateLimitConfig {
  safetyMargin: number;    // Stop requests before hitting limit (default: 100)
  maxQueueSize: number;     // Maximum queued requests (default: 50)
  maxConcurrency: number;    // Parallel requests (default: 3)
}

class GitHubAPIClient {
  private rateLimit: GitHubRateLimit | null = null;
  private requestQueue: Array<() => Promise<unknown>> = [];
  private activeRequests = 0;
  private config: GitHubRateLimitConfig;

  async execute<T>(
    operation: string,
    args: string[],
    parseOutput: (stdout: string) => T
  ): Promise<T> {
    // 1. Check if we should wait based on rate limit
    await this.checkAndWait();

    // 2. Execute with rate limit header extraction
    const result = await this.executeWithTracking(args, parseOutput);

    // 3. Update rate limit state from response headers
    this.updateRateLimit(result.headers);

    return result.data;
  }

  private async checkAndWait(): Promise<void> {
    if (!this.rateLimit) return;

    const now = Date.now();
    const remaining = this.rateLimit.remaining - this.config.safetyMargin;

    if (remaining <= 0 && now < this.rateLimit.resetAt.getTime()) {
      const waitTime = this.rateLimit.resetAt.getTime() - now;
      console.warn(
        `[GitHub API] Rate limit reached. Waiting ${waitTime}ms until reset.`
      );
      await this.sleep(waitTime);
    }
  }

  private updateRateLimit(headers: Record<string, string>): void {
    // Extract from gh CLI response or proxy
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];

    if (remaining && reset) {
      this.rateLimit = {
        remaining: parseInt(remaining),
        resetAt: new Date(parseInt(reset) * 1000),
        limit: parseInt(headers['x-ratelimit-limit'] || '5000'),
        used: parseInt(headers['x-ratelimit-used'] || '0'),
      };
    }
  }
}
```

### Challenge: `gh` CLI Doesn't Expose Rate Limit Headers

The `gh` CLI consumes rate limit headers internally and doesn't expose them.

**Solution options:**

1. **Use GitHub REST API directly** (bypass `gh` CLI)
   - Pro: Full access to rate limit headers
   - Con: Lose `gh` CLI convenience and auth handling

2. **Parse `gh` error messages** for rate limit signals
   - When rate-limited, `gh` returns: `HTTP 403: API rate limit exceeded`
   - Pro: Works with existing CLI usage
   - Con: Reactive (only detect after hit)

3. **Hybrid approach**: Use `gh` for most calls, sample with direct API calls
   - Periodically call `/rate_limit` endpoint via direct REST API
   - Update client's internal rate limit state
   - Continue using `gh` for all other operations

**Recommendation**: Option 3 (Hybrid) — maintains compatibility while adding visibility.

---

## Component 2: Request Queue with Throttling

### Adaptive Throttling Strategy

```typescript
class RequestThrottler {
  private queue: QueuedRequest[] = [];
  private activeRequests = 0;
  private rateLimiter: TokenBucket;

  async enqueue<T>(request: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const item: QueuedRequest<T> = { request, resolve, reject };
      this.queue.push(item);
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.activeRequests >= this.config.maxConcurrency) {
      return;
    }
    if (this.queue.length === 0) {
      return;
    }

    // Check rate limit token bucket
    if (!this.rateLimiter.tryAcquire()) {
      const waitTime = this.rateLimiter.timeUntilNextToken();
      setTimeout(() => this.processQueue(), waitTime);
      return;
    }

    const item = this.queue.shift()!;
    this.activeRequests++;

    try {
      const result = await item.request();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      this.activeRequests--;
      this.processQueue();
    }
  }
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(capacity: number, refillRate: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
    this.capacity = capacity;
    this.refillRate = refillRate; // tokens per second
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  timeUntilNextToken(): number {
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit / this.refillRate) * 1000);
  }
}
```

### Token Bucket Configuration

| Scenario | Capacity | Refill Rate |
|----------|-----------|--------------|
| Conservative (60/hour) | 60 | 60/3600 = 0.017/sec |
| Standard (5k/hour) | 100 | 1000/sec (burst) |
| Aggressive | 500 | 1500/sec |

---

## Component 3: GraphQL Query Consolidation

### Problem: REST API Calls Are Chatty

6 separate REST calls = 6 requests for data that could be fetched in 1 GraphQL query.

### Solution: Consolidated GraphQL Queries

```graphql
# Get all PR data needed for dashboard in one query
query PRDashboardData($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state
      title
      isDraft
      additions
      deletions
      headRefName
      baseRefName
      mergeable
      mergeStateStatus
      reviewDecision
      statusCheckRollup {
        contexts {
          name
          status
          conclusion
          targetUrl
          startedAt
          completedAt
        }
      }
      reviewThreads(first: 100) {
        totalCount
        nodes {
          isResolved
          comments(first: 1) {
            nodes {
              id
              author { login }
              body
              path
              line
              url
              createdAt
            }
          }
        }
      }
    }
  }
}
```

### Points Cost Comparison

| Operation | REST Requests | GraphQL Points |
|-----------|---------------|----------------|
| PR summary + checks + reviews + comments | 6 | ~150 |
| **Savings**: ~4 requests reduced per PR |

### Implementation Strategy

1. **Phase 1**: Add GraphQL wrapper to `GitHubAPIClient`
2. **Phase 2**: Migrate dashboard PR enrichment to use GraphQL
3. **Phase 3**: Keep REST as fallback for individual operations

---

## Component 4: Enhanced Caching

### Current Cache Analysis

| Cache | TTL | Coverage |
|-------|-----|----------|
| PR enrichment | 5 min (60 min when rate-limited) | Dashboard only |
| Issue titles | 5 min | Dashboard only |
| ❌ Tracker plugin | None | No caching |
| ❌ SCM plugin | None | No caching |

### Proposed: Distributed Cache Layer

```typescript
// packages/core/src/github-cache.ts
class GitHubCache {
  private cache: Map<string, CacheEntry>;
  private persistentCache?: PersistentCache;

  async get(key: string, maxAge?: number): Promise<unknown | null> {
    // 1. Check memory cache
    const memoryHit = this.cache.get(key);
    if (memoryHit && !this.isExpired(memoryHit, maxAge)) {
      return memoryHit.value;
    }

    // 2. Check persistent cache (file system or Redis)
    if (this.persistentCache) {
      const diskHit = await this.persistentCache.get(key);
      if (diskHit && !this.isExpired(diskHit, maxAge)) {
        // Promote to memory cache
        this.cache.set(key, diskHit);
        return diskHit.value;
      }
    }

    return null;
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    const entry: CacheEntry = {
      value,
      expiresAt: Date.now() + (ttl || this.defaultTTL),
    };

    // Write to both memory and persistent
    this.cache.set(key, entry);
    if (this.persistentCache) {
      await this.persistentCache.set(key, entry);
    }
  }
}
```

### Cache Key Strategy

```typescript
function prCacheKey(owner: string, repo: string, number: number): string {
  return `gh:pr:${owner}/${repo}:${number}`;
}

function ciCacheKey(owner: string, repo: string, sha: string): string {
  return `gh:ci:${owner}/${repo}:${sha}`;
}

function issueCacheKey(owner: string, repo: string, number: number): string {
  return `gh:issue:${owner}/${repo}:${number}`;
}
```

### Cache TTL by Data Type

| Data Type | Freshness Requirement | Recommended TTL |
|-----------|---------------------|------------------|
| PR state (open/closed/merged) | High (changes frequently) | 1-2 min |
| CI checks | High (runs trigger updates) | 1 min |
| Review decision | Medium | 3-5 min |
| Mergeability (conflicts) | Medium | 3-5 min |
| Issue title | Low (rarely changes) | 30 min |
| Issue description | Low | 30 min |
| Issue labels | Medium | 10 min |

---

## Component 5: Webhook-Driven Updates

### Problem: Dashboard Polls GitHub API

Even with caching, the dashboard periodically refreshes data, causing API usage.

### Solution: Use GitHub Webhooks for Real-Time Updates

1. **Webhook events to handle:**
   - `pull_request` — PR state, title, draft status changes
   - `pull_request_review` — Review decision changes
   - `check_run` / `check_suite` / `status` — CI status changes
   - `issue_comment` — Review comments added/removed

2. **Webhook → Cache Invalidation Strategy:**

```typescript
// packages/web/server/webhook-handler.ts
async function handlePRWebhook(event: GitHubWebhookEvent): Promise<void> {
  const cacheKey = prCacheKey(event.owner, event.repo, event.prNumber);

  // Invalidate relevant cache entries
  switch (event.action) {
    case 'opened':
    case 'edited':
    case 'closed':
    case 'reopened':
      prCache.delete(cacheKey);
      break;

    case 'synchronize':
      // Only invalidate CI-related data
      prCache.updatePartial(cacheKey, { ciChecks: null, ciStatus: null });
      break;
  }

  // Broadcast SSE update to connected dashboards
  broadcastUpdate({
    type: 'pr.updated',
    owner: event.owner,
    repo: event.repo,
    prNumber: event.prNumber,
  });
}
```

3. **Dashboard polling as fallback:**
   - Poll only when no webhook received in last 5 minutes
   - Reduces API calls by ~90% in steady state

---

## Component 6: Rate Limit Observability

### Metrics to Track

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `github.api.requests.total` | Total requests made | N/A |
| `github.api.requests.rate_limited` | Requests that hit rate limit | > 0 |
| `github.api.cache.hit_rate` | Cache hit percentage | < 70% warn |
| `github.api.queue.depth` | Current queue length | > 10 warn |
| `github.api.wait_time.p99` | P99 wait time for queued requests | > 5s warn |

### UI Indicators

```
┌────────────────────────────────────────────────────┐
│  Dashboard Header                                 │
│                                                 │
│  [●] GitHub API: 4,234/5,000 (85%)          │
│       ^ Green = OK, Yellow = Warning, Red = Limited│
│                                                 │
│  ⚠ High API usage detected. Reduce polling.       │
└────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Core Infrastructure (1-2 weeks)

1. **Create `GitHubAPIClient` module**
   - File: `packages/core/src/github-client.ts`
   - Implement request queue and throttling
   - Add rate limit detection via sampling

2. **Add distributed cache layer**
   - File: `packages/core/src/github-cache.ts`
   - In-memory + file-system persistence
   - Configurable TTL per data type

3. **Observability integration**
   - Hook into existing observer system
   - Emit metrics for rate limit tracking

### Phase 2: Plugin Migration (1-2 weeks)

1. **Update `scm-github` plugin**
   - Add `GitHubAPIClient` dependency
   - Wrap all `gh()` calls through client
   - Add cache to tracker operations

2. **Update `tracker-github` plugin**
   - Same pattern as scm-github
   - Cache issue data

### Phase 3: GraphQL Optimization (1 week)

1. **Add GraphQL support to `GitHubAPIClient`**
   - Query templates for common operations
   - REST fallback for individual calls

2. **Migrate dashboard enrichment**
   - Replace parallel REST calls with single GraphQL query
   - Test fallback to REST on failure

### Phase 4: Webhook Integration (1-2 weeks)

1. **Implement webhook handler**
   - New API route: `/api/webhooks/github`
   - Event parsing and validation
   - Cache invalidation

2. **Update dashboard SSE**
   - Forward webhook updates as SSE events
   - Reduce polling frequency

### Phase 5: Testing & Rollout (1 week)

1. **Integration tests**
   - Simulate rate limit scenarios
   - Verify cache behavior
   - Test webhook delivery

2. **Gradual rollout**
   - Feature flag for new client
   - Monitor metrics
   - Rollback plan if issues

---

## Migration Considerations

### Backward Compatibility

1. **Gradual rollout via feature flag:**
   ```typescript
   const useNewGitHubClient =
     process.env.GITHUB_CLIENT_V2 === 'true' ||
     process.env.GITHUB_USE_RATE_LIMITING === 'true';
   ```

2. **Keep existing `gh()` wrapper functions**
   - Mark as deprecated
   - Remove after successful rollout

### Configuration

```typescript
// packages/core/src/config.ts
interface GitHubAPIConfig {
  enabled: boolean;              // Enable new client (default: false initially)
  maxConcurrency: number;        // Default: 3
  queueSize: number;             // Default: 50
  useGraphQL: boolean;           // Default: true
  enableWebhooks: boolean;       // Default: false
  cacheTTL: {                  // Per-type TTLs
    pr: number;
    ci: number;
    issue: number;
  };
}
```

---

## Risk Assessment

| Risk | Impact | Mitigation |
|-------|---------|------------|
| Increased complexity | Medium | Well-tested modules, gradual rollout |
| Cache staleness | Low | Conservative TTLs, webhook invalidation |
| `gh` CLI compatibility | Low | Wrapper pattern preserves existing behavior |
| GraphQL query limits | Low | Fall back to REST on failures |
| Webhook delivery failures | Medium | Polling fallback maintains data freshness |

---

## Success Metrics

1. **API call reduction**: Target 50% reduction in daily API calls
2. **Rate limit incidents**: Target 0 incidents per week
3. **Cache hit rate**: Target >80% for dashboard refreshes
4. **Dashboard latency**: Maintain <500ms page load time
5. **User feedback**: No regression reports related to stale data

---

## Appendix: Current API Usage Audit

### Files with GitHub API Calls

| File | Plugin | Operations |
|------|---------|-------------|
| `packages/plugins/scm-github/src/index.ts` | scm-github | `gh pr view`, `gh pr checks`, `gh api graphql`, `gh pr list` |
| `packages/plugins/tracker-github/src/index.ts` | tracker-github | `gh issue view`, `gh issue list`, `gh issue create`, `gh issue edit`, `gh issue close` |
| `packages/core/src/session-manager.ts` | core | `gh pr view` (via plugin) |

### API Call Frequency Analysis

Assuming 20 active sessions with dashboard refreshing every 30 seconds:

- Without mitigation: 20 sessions × 6 calls × 2 refreshes/minute = **240 calls/minute**
- With 5-minute cache: **~48 calls/minute** (80% reduction)
- With webhook-driven updates: **~12 calls/minute** (95% reduction)
- Rate limit at 5,000/hour = 83 calls/minute allowed
- **Conclusion**: Current caching is insufficient; webhooks are necessary for scale

---

*Design document v1.0 — March 2026*
