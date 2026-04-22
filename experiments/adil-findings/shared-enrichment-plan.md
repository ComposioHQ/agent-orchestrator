# Shared PR Enrichment — Eliminate Dashboard API Calls

**Date:** 2026-04-23
**Branch:** `feat/gh-rate-limiting`
**Depends on:** Step 1 (remove fallback) + Step 2 (consolidate review comments) from `ao-rate-limit-reduction-plan.md`

## Problem

The CLI lifecycle manager and the web dashboard are **two separate Node.js processes** that both call the GitHub API independently for the same data. They share nothing — each has its own plugin registry, SCM plugin, lifecycle manager, and cache layers.

The lifecycle manager already fetches all PR enrichment data (batch query every 30s) and review comments (GraphQL every 2min). The dashboard ignores this and makes its own individual REST/GraphQL calls with a 5-minute TTL cache.

**Result:** ~50% of all AO-side API traffic is duplication (see `duplicate-api-traffic-analysis.md`).

## Solution

**Persist the enrichment data to session metadata files on disk.** The lifecycle manager already writes 15+ metadata keys per session per cycle. Add one more key: `prEnrichment` — a JSON blob with everything the dashboard needs. The dashboard reads from disk instead of calling GitHub.

## What the lifecycle manager writes today

Per session, per poll cycle, to `~/.agent-orchestrator/{hash}/sessions/{sessionId}`:

| Key | Value |
|-----|-------|
| `stateVersion` | `"2"` |
| `statePayload` | Full lifecycle JSON (session/PR/runtime state + reasons) |
| `status` | Legacy status string |
| `pr` | PR URL |
| `runtimeHandle` | Runtime handle JSON |
| `tmuxName` | Tmux session name |
| `role` | `"orchestrator"` or `""` |
| `lifecycleEvidence` | Evidence string |
| `detectingAttempts` | Stuck detection counter |
| `detectingStartedAt` | Timestamp |
| `detectingEscalatedAt` | Timestamp |
| `lastPendingReviewFingerprint` | Hash of review comment IDs |
| `lastPendingReviewDispatchHash` | Hash of last dispatched comments |
| `lastPendingReviewDispatchAt` | Timestamp |
| `lastAutomatedReviewFingerprint` | Hash of bot comment IDs |
| `lastAutomatedReviewDispatchHash` | Hash of last dispatched |
| `lastAutomatedReviewDispatchAt` | Timestamp |

## What we add

One new key:

| Key | Value | Updated |
|-----|-------|---------|
| `prEnrichment` | JSON blob (see below) | Every 30s (batch data) + every 2 min (comments) |

### `prEnrichment` schema

```typescript
{
  // From batch query (refreshed every 30s)
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  additions: number;
  deletions: number;
  isDraft: boolean;
  ciStatus: "passing" | "failing" | "pending" | "none";
  ciChecks: Array<{ name: string; status: string; url?: string }>;
  reviewDecision: "approved" | "changes_requested" | "pending" | "none";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;

  // From review threads GraphQL (refreshed every 2 min)
  // Single GraphQL call, split locally by BOT_AUTHORS
  unresolvedComments: Array<{
    id: string;
    author: string;
    body: string;
    path?: string;
    line?: number;
    url: string;
    isBot: boolean;  // lifecycle splits by this for reactions
  }>;

  // Metadata
  enrichedAt: string;       // ISO timestamp of batch enrichment
  commentsUpdatedAt: string; // ISO timestamp of last comment fetch
}
```

## Implementation Steps

### Step A: Persist enrichment in lifecycle manager

**File:** `packages/core/src/lifecycle-manager.ts`

After `populatePREnrichmentCache()` (line 1883), write enrichment data to each session's metadata:

```typescript
for (const s of sessionsToCheck) {
  if (!s.pr) continue;
  const prKey = `${s.pr.owner}/${s.pr.repo}#${s.pr.number}`;
  const cached = prEnrichmentCache.get(prKey);
  if (cached) {
    updateSessionMetadata(s, {
      prEnrichment: JSON.stringify({
        ...cached,
        enrichedAt: new Date().toISOString(),
      }),
    });
  }
}
```

For review comments, update `prEnrichment` inside `maybeDispatchReviewBacklog()` after fetching comments (line 1157-1160). Merge comments into the existing `prEnrichment` blob:

```typescript
const existingEnrichment = JSON.parse(session.metadata["prEnrichment"] || "{}");
existingEnrichment.unresolvedComments = allComments.map(c => ({
  id: c.id,
  author: c.author,
  body: c.body,
  path: c.path,
  line: c.line,
  url: c.url,
  isBot: BOT_AUTHORS.has(c.author),
}));
existingEnrichment.commentsUpdatedAt = new Date().toISOString();
updateSessionMetadata(session, {
  prEnrichment: JSON.stringify(existingEnrichment),
});
```

### Step B: Create shared enrichment reader in dashboard

**New file:** `packages/web/src/lib/pr-enrichment.ts`

```typescript
export function readPREnrichment(metadata: Record<string, string>): PREnrichmentData | null {
  const raw = metadata["prEnrichment"];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
```

Single function. Every consumer calls this instead of GitHub.

### Step C: Dashboard reads from disk instead of API

**File:** `packages/web/src/lib/serialize.ts`

Replace `enrichSessionPR()` implementation — instead of calling `scm.getPRState()`, `scm.getCIChecks()`, etc., call `readPREnrichment(coreSession.metadata)`:

```typescript
export function enrichSessionPR(
  dashboard: DashboardSession,
  coreSession: Session,
): boolean {
  const data = readPREnrichment(coreSession.metadata);
  if (!data) return false;

  dashboard.pr.state = data.state;
  dashboard.pr.title = data.title;
  dashboard.pr.additions = data.additions;
  dashboard.pr.deletions = data.deletions;
  dashboard.pr.ciStatus = data.ciStatus;
  dashboard.pr.ciChecks = data.ciChecks;
  dashboard.pr.reviewDecision = data.reviewDecision;
  dashboard.pr.mergeability = data.mergeability;
  dashboard.pr.unresolvedComments = data.unresolvedComments?.filter(c => !c.isBot);
  dashboard.pr.enriched = true;
  return true;
}
```

No async. No API calls. No cache. Just read a string from metadata and parse it.

### Step D: Remove web's lifecycle manager

**File:** `packages/web/src/lib/services.ts`

Remove lines 92-93:
```typescript
// DELETE:
const lifecycleManager = createLifecycleManager({ config, registry, sessionManager });
lifecycleManager.start(30_000);
```

The web process no longer polls GitHub. It only serves dashboard data from disk.

### Step E: Remove dashboard's prCache

**File:** `packages/web/src/lib/cache.ts`

The `prCache` (5-min TTL) is no longer needed. The metadata file is always fresh (30s from lifecycle). Remove `prCache`, `prCacheKey`, `PREnrichmentData` from this file.

### Step F: Clean up unused SCM calls in web routes

**Files:**
- `packages/web/src/app/api/sessions/route.ts` — remove `enrichSessionPR` API call loop (lines 90-110)
- `packages/web/src/app/api/sessions/[id]/route.ts` — remove `enrichSessionPR` API call (lines 41-46)

Replace with the new synchronous `enrichSessionPR` that reads from metadata.

## What gets eliminated

| Removed | Impact |
|---------|--------|
| Web lifecycle manager (Guard 1 + Guard 2 + batch + reactions) | ~193 calls / 15 min |
| Dashboard `enrichSessionPR` individual API calls | ~75 calls / 15 min |
| Dashboard `prCache` TTL cache | Unnecessary complexity |
| Web process SCM plugin GitHub calls | **Zero API calls from web process** |
| **Total** | **~268 calls / 15 min (58% of all traffic)** |

## What remains

| Component | Calls | Purpose |
|-----------|-------|---------|
| CLI lifecycle batch (Guard + GraphQL) | ~100 / 15 min | Single source of truth for PR state |
| CLI lifecycle review comments (GraphQL) | ~40 / 15 min | Review thread detection + reactions |
| CLI lifecycle detectPR (REST) | ~82 / 15 min | PR discovery (until PR found) |
| CLI lifecycle issue view (REST) | ~27 / 15 min | Issue context |
| **Total** | **~249 / 15 min** (down from 465) |

## Data freshness

| Data | Current (dashboard) | After this change |
|------|--------------------:|------------------:|
| PR state/CI/reviews | 5 min (prCache TTL) | **30s** (lifecycle batch cycle) |
| Review comments | 5 min (prCache TTL) | **2 min** (lifecycle throttle) |

Dashboard data actually gets **fresher**, not staler.

## Risks

| Risk | Mitigation |
|------|------------|
| CLI not running → no `prEnrichment` in metadata | Dashboard shows un-enriched data (`enriched: false`) — already handled |
| Metadata file write conflicts (two writers) | Only one writer now (CLI lifecycle). Web only reads. |
| `prEnrichment` JSON blob too large | Review comments are the biggest part. 100 threads × ~200 bytes each = ~20KB. Acceptable for a metadata file. |

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/lifecycle-manager.ts` | Persist `prEnrichment` after batch + after comment fetch |
| `packages/web/src/lib/pr-enrichment.ts` | **New** — shared reader for enrichment data |
| `packages/web/src/lib/serialize.ts` | Read from metadata instead of API calls |
| `packages/web/src/lib/services.ts` | Remove lifecycle manager creation |
| `packages/web/src/lib/cache.ts` | Remove `prCache` |
| `packages/web/src/app/api/sessions/route.ts` | Use new enrichment reader |
| `packages/web/src/app/api/sessions/[id]/route.ts` | Use new enrichment reader |
