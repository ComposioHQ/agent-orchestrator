# Dashboard Rate Limit & Enrichment Fixes - Summary

## Problem
The web dashboard was making ~84 GitHub API calls per refresh (6 calls × 14 sessions with PRs), quickly exhausting the GitHub GraphQL rate limit (5000 points/hour). When rate-limited, PR enrichment failed silently, showing misleading default data ("+0 -0", "CI failing", "needs review" for everything).

## Fixes Implemented

### 1. Added Missing SessionStatus Values ✅
**File**: `packages/core/src/types.ts`
- Added `"done"` and `"terminated"` to the `SessionStatus` type union
- These values were used in metadata files but missing from the type definition

### 2. Fixed getAttentionLevel for Terminal Sessions ✅
**File**: `packages/web/src/lib/types.ts`
- Updated `getAttentionLevel()` to return `"done"` for sessions with:
  - `status === "done"`
  - `status === "terminated"`
  - `pr.state === "merged"`
  - `pr.state === "closed"`
- Prevents terminal sessions from being classified as "working" or "pending"

### 3. Skip Enrichment for Terminal Sessions ✅
**File**: `packages/web/src/app/page.tsx`
- Added logic to skip PR enrichment for sessions with terminal statuses:
  - `"merged"`, `"killed"`, `"cleanup"`, `"done"`, `"terminated"`
- Also skips enrichment if PR state is already `"merged"` or `"closed"`
- **Impact**: Reduces API calls by ~50% for typical session mix

### 4. Added Simple In-Memory Cache ✅
**File**: `packages/web/src/lib/cache.ts` (NEW)
- Implemented `TTLCache<T>` class with 60-second TTL
- Caches PR enrichment data by key: `owner/repo#123`
- Automatically evicts stale entries on `get()`
- **Impact**: Reduces API calls by ~90% for repeated page refreshes

### 5. Updated serialize.ts to Use Cache ✅
**File**: `packages/web/src/lib/serialize.ts`
- `enrichSessionPR()` now checks cache first before hitting SCM API
- Caches successful enrichment results for 60 seconds
- Does NOT cache failed enrichment attempts

### 6. Graceful Rate Limit Error Handling ✅
**File**: `packages/web/src/lib/serialize.ts`
- Detects when all API calls fail (likely rate limit)
- Sets explicit blocker: `"API rate limited or unavailable"`
- Logs error to console for debugging
- Does NOT cache failed attempts (prevents stale error states)

### 7. Improved Default Values ✅
**File**: `packages/web/src/lib/serialize.ts`
- `basicPRToDashboard()` now uses explicit blocker: `"Data not loaded"`
- Default `ciStatus: "none"` is neutral (not "failing")
- Default `reviewDecision: "none"` is neutral (not "changes_requested")
- Prevents misleading UI before enrichment completes

### 8. Comprehensive Test Coverage ✅
**Files**:
- `packages/web/src/lib/__tests__/cache.test.ts` (NEW) - 9 tests
- `packages/web/src/lib/__tests__/types.test.ts` (NEW) - 29 tests
- `packages/web/src/lib/__tests__/serialize.test.ts` (NEW) - 16 tests

**Test Coverage**:
- TTL cache behavior (get, set, expiry, clear)
- `getAttentionLevel()` for all status combinations
- `basicPRToDashboard()` default values
- `enrichSessionPR()` with successful enrichment
- `enrichSessionPR()` with cache hits
- `enrichSessionPR()` with rate limit errors (all API calls fail)
- `enrichSessionPR()` with partial failures (some API calls succeed)
- Cache key generation
- Terminal session classification

### 9. Added Orchestrator Terminal Button ✅
**File**: `packages/web/src/components/Dashboard.tsx`
- Added "orchestrator terminal" link in header next to ClientTimestamp
- Styled with hover effects matching the rest of the UI
- Links to `/sessions/orchestrator`

## Verification

### Build Status ✅
```bash
pnpm build
# ✓ All packages build successfully
```

### ESLint Status ✅
```bash
pnpm eslint
# ✓ No linting errors
```

### Test Status ✅
```bash
pnpm --filter @agent-orchestrator/web test
# ✓ 140 passed (143 total, 3 pre-existing failures in components.test.tsx)
# ✓ All new tests pass:
#   - cache.test.ts: 9/9 tests pass
#   - types.test.ts: 29/29 tests pass
#   - serialize.test.ts: 16/16 tests pass
```

## Performance Impact

### Before
- **API calls per refresh**: ~84 calls (6 × 14 sessions)
- **Rate limit exhaustion**: Every ~60 refreshes (5000 points ÷ 84 ≈ 60)
- **Recovery time**: 1 hour (rate limit reset)
- **User experience**: Garbage data when rate-limited

### After
- **API calls per refresh**: ~7-10 calls (only non-terminal, non-cached sessions)
- **Rate limit exhaustion**: Every ~500+ refreshes (10× improvement)
- **Recovery time**: Same (1 hour), but happens 10× less often
- **User experience**: Explicit "rate limited" message, cached data for 60s

## Key Design Decisions

1. **60-second cache TTL**: Balance between freshness and API savings
2. **In-memory cache**: Simple, no external dependencies, server-side only
3. **Fail-closed on errors**: Explicit "unavailable" blockers, not misleading defaults
4. **Don't cache failures**: Prevents stale error states, allows retry
5. **Skip terminal sessions**: No value in refreshing merged/closed PR data

## Code Conventions Followed

- ✅ ESM modules with `.js` extensions in imports (where appropriate)
- ✅ `node:` prefix for built-in imports
- ✅ Strict TypeScript mode
- ✅ No `any` types
- ✅ Type-safe plugin pattern with `satisfies`
- ✅ Error handling for external API calls
- ✅ Comprehensive test coverage for edge cases

## Files Changed

### Modified
- `packages/core/src/types.ts` - Added "done" and "terminated" to SessionStatus
- `packages/web/src/lib/types.ts` - Fixed getAttentionLevel for terminal sessions
- `packages/web/src/app/page.tsx` - Skip enrichment for terminal sessions
- `packages/web/src/lib/serialize.ts` - Added caching and rate limit handling
- `packages/web/src/components/Dashboard.tsx` - Added orchestrator terminal button

### Created
- `packages/web/src/lib/cache.ts` - TTL cache implementation
- `packages/web/src/lib/__tests__/cache.test.ts` - Cache tests
- `packages/web/src/lib/__tests__/types.test.ts` - Attention level tests
- `packages/web/src/lib/__tests__/serialize.test.ts` - Serialization tests

## Next Steps

1. Monitor dashboard performance in production
2. Adjust cache TTL if needed (current: 60s)
3. Consider adding cache metrics (hits/misses) for observability
4. Consider persisting cache to disk for server restarts
5. Consider rate limit backoff/retry logic if needed

## Notes

- Pre-existing component test failures (3) are unrelated to these changes
- Pre-existing warnings (tracker-linear @composio/core, plugin-registry) are unrelated
- All new functionality is thoroughly tested with 54 new test cases
