# Request Review: Replace "Ask to Post" with GitHub Review Requests

**Date:** 2026-03-24
**Status:** Draft

## Problem

The kanban card's "ask to post" button currently sends a message to the agent: `"Post {pr.url} on slack asking for a review."` This assumes Slack integration exists. It doesn't — the team uses GitHub only. The action is unreliable because it depends on the agent interpreting a free-text message correctly.

## Solution

Replace the agent-message approach with a direct GitHub API call that requests reviewers on the PR. Reviewers are configured per-project via a new `defaultReviewers` field in `ProjectConfig`.

## Design

### 1. Config & Types (`packages/core/src/types.ts`)

**ProjectConfig** — add `defaultReviewers`:

```typescript
export interface ProjectConfig {
  // ... existing fields ...

  /** GitHub usernames or team slugs to request as PR reviewers */
  defaultReviewers?: string[];
}
```

**SCM interface** — add `requestReviewers`:

```typescript
export interface SCM {
  // ... existing methods ...

  /** Request reviewers on a PR. Optional — not all SCM backends may support it. */
  requestReviewers?(pr: PRInfo, reviewers: string[]): Promise<void>;
}
```

**User configuration example:**

```json
{
  "projects": {
    "my-app": {
      "repo": "org/my-app",
      "path": "/home/user/my-app",
      "defaultBranch": "main",
      "sessionPrefix": "app",
      "defaultReviewers": ["alice", "org/frontend-team"]
    }
  }
}
```

### 2. GitHub SCM Plugin (`packages/plugins/scm-github/src/index.ts`)

Implement `requestReviewers` using the `gh` CLI, consistent with all other methods in this plugin:

```typescript
async requestReviewers(pr: PRInfo, reviewers: string[]): Promise<void> {
  await gh([
    "pr", "edit", String(pr.number),
    "--repo", repoFlag(pr),
    ...reviewers.flatMap(r => ["--add-reviewer", r]),
  ]);
}
```

> Uses the existing `gh()` helper and `repoFlag(pr)` pattern consistent with all other methods (e.g., `assignPRToCurrentUser`, `mergePR`, `closePR`).

This adds individual users and team slugs (e.g., `org/team-name`) as reviewers via GitHub's native review request mechanism. Requested users receive GitHub notifications automatically.

### 3. API Route (`packages/web/src/app/api/prs/[id]/request-review/route.ts`)

New `POST /api/prs/:id/request-review` endpoint. Follows the same pattern as the existing merge route (`/api/prs/[id]/merge/route.ts`):

1. Validate PR number (must be numeric)
2. Find session by PR number from session manager
3. Look up project config for the session
4. Get SCM plugin for the project; return 500 if not configured
5. Check that `requestReviewers` is supported by the SCM plugin; return 501 if not
6. Read `defaultReviewers` from project config; return 422 if not configured or empty
7. Call `scm.requestReviewers(pr, defaultReviewers)`
8. Record observability data
9. Return `{ ok: true, prNumber, reviewers: [...] }`

**Error responses:**

| Status | Condition |
|--------|-----------|
| 400 | Invalid PR number |
| 404 | PR/session not found |
| 422 | `defaultReviewers` not configured for the project |
| 500 | SCM plugin not configured |
| 501 | SCM plugin does not support `requestReviewers` |

### 4. Frontend Changes

**Dashboard** (`packages/web/src/components/Dashboard.tsx`):

Add `handleRequestReview` callback following the `handleMerge` pattern:

```typescript
const handleRequestReview = useCallback(async (prNumber: number) => {
  const res = await fetch(`/api/prs/${prNumber}/request-review`, { method: "POST" });
  if (!res.ok) {
    console.error(`Failed to request review for PR #${prNumber}:`, await res.text());
  }
}, []);
```

Pass `onRequestReview` down through `AttentionZone` to `SessionCard`.

**SessionCard** (`packages/web/src/components/SessionCard.tsx`):

For the "needs review" alert (currently lines 659-669):

- Remove the `actionMessage` field (no longer sending agent messages for this action)
- The button click calls `onRequestReview(pr.number)` instead of `handleAction` / `onSend`
- Button label changes from "ask to post" to "request review" (clearer without Slack context)
- On click: optimistically show "sent!" feedback for 2 seconds (same UX as today — no loading/error state)

**Note:** Adding `onRequestReview` to `AttentionZone` props also requires updating `areAttentionZonePropsEqual` (the custom memoization comparator) to include it.

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Add `defaultReviewers` to `ProjectConfig`, add `requestReviewers` to `SCM` |
| `packages/plugins/scm-github/src/index.ts` | Implement `requestReviewers` via `gh pr edit --add-reviewer` |
| `packages/web/src/app/api/prs/[id]/request-review/route.ts` | New API route (mirrors merge route pattern) |
| `packages/web/src/components/Dashboard.tsx` | Add `handleRequestReview` callback, pass to children |
| `packages/web/src/components/AttentionZone.tsx` | Thread `onRequestReview` prop through |
| `packages/web/src/components/SessionCard.tsx` | Wire "needs review" button to `onRequestReview`, rename label |

## Out of Scope

- Reviewer selection logic (CODEOWNERS, round-robin, load-balancing) — always uses `defaultReviewers` from config
- Slack or other notification channels
- GitLab support (can be added later by implementing `requestReviewers` in `scm-gitlab`)
