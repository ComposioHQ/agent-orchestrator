# Feature Plan: Sidebar Reconnect & Loading State

**Issue:** sidebar-reconnect-loading-state
**Branch:** `feat/sidebar-reconnect-loading-state`
**Status:** Pending

---

## Problem Summary

On mobile Chrome (and any browser that suspends background tabs), switching away from the app and returning causes the sidebar to appear completely empty. It shows nothing for projects/sessions and only the terminal header remains visible. Data returns after several seconds when the next polling interval fires.

## Root Cause

Three compounding issues in `packages/web/src/app/(with-sidebar)/layout.tsx`:

### 1. No Page Visibility handling
The 10-second polling `setInterval` is throttled or frozen by the browser when the tab is backgrounded. When the user returns, the next poll tick may be up to 10 seconds away. There is no `visibilitychange` listener to trigger an immediate re-fetch on tab resume.

### 2. State resets to empty on error/re-fetch
On any fetch failure the catch block resets all state to `[]`. On re-fetch after returning, the old data is thrown away immediately before new data arrives — causing a blank flash even when data was previously loaded.

### 3. No loading state — `null` rendered instead
`ProjectSidebar` returns `null` when `projects.length <= 1`. There is no distinction between "currently loading" and "genuinely empty". First load and post-reconnect both show nothing.

## Proposed Approach

### Fix 1 — Page Visibility re-fetch (`layout.tsx`)

Add a `visibilitychange` listener alongside the existing polling interval. When the tab becomes visible again, immediately call `loadSidebarData()`:

```ts
const handleVisibility = () => {
  if (document.visibilityState === "visible") {
    void loadSidebarData();
  }
};
document.addEventListener("visibilitychange", handleVisibility);
// clean up in the same useEffect return
```

### Fix 2 — Keep stale data during re-fetch (`layout.tsx`)

Move state setters to only update when the response is actually OK and parsed. Never reset to `[]` on error — if we already have data, keep it. Only fall back to `[]` on the very first load if fetch fails.

```ts
// Before (resets everything on error):
} catch {
  setProjects([]);
  setSessions([]);
  setTerminals([]);
}

// After (keep stale data, only update on success):
} catch {
  // Only reset if we've never loaded data (isLoading is still true)
  if (!hasLoadedOnce.current) {
    setLoadError(true);
  }
  // Otherwise: keep current state intact — stale data is better than blank
}
```

Use a `hasLoadedOnce` ref (not state, to avoid re-renders) that flips to `true` after the first successful fetch.

### Fix 3 — Loading state in sidebar (`layout.tsx` + `ProjectSidebar.tsx`)

Add an `isLoading: boolean` prop to `ProjectSidebar`. When `true` and data is empty, show a skeleton instead of `null`.

In `layout.tsx`:
```ts
const [isLoading, setIsLoading] = useState(true);
// After first successful fetch:
setIsLoading(false);
```

In `ProjectSidebar.tsx`, replace the early `return null` guard:
```tsx
// Before:
if (props.projects.length <= 1) return null;

// After:
if (props.isLoading) return <SidebarSkeleton />;
if (props.projects.length <= 1) return null;
```

`SidebarSkeleton` is a simple component with 2-3 grey placeholder rows — no animation needed, just enough to show the sidebar isn't broken.

### Fix 4 — SSE reconnect on visibility change

`useSessionEvents` (used inside Dashboard/session pages, not the layout) handles SSE. When tab returns visible and SSE is in "disconnected" state, the browser will auto-reconnect `EventSource` per spec — but it may take a few seconds. The `visibilitychange` handler in the layout handles the data re-fetch independently, so SSE reconnect timing is less critical here. No explicit SSE-level change needed for this issue.

## Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/app/(with-sidebar)/layout.tsx` | Add `visibilitychange` listener; add `isLoading` state; add `hasLoadedOnce` ref; stop resetting to `[]` on error when data already loaded |
| `packages/web/src/components/ProjectSidebar.tsx` | Add `isLoading` prop; render `SidebarSkeleton` when loading instead of `null` |

## Risks and Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Should `isLoading` go back to `true` after visibility change re-fetch? | No — we have stale data to show. Only `true` on first mount before any data arrives. |
| 2 | What about the collapsed sidebar variant? | `SidebarSkeleton` for collapsed can just be 2-3 grey circle placeholders — same treatment. |
| 3 | iOS Safari vs Chrome — any difference in visibility events? | Both support `visibilitychange` reliably. iOS Safari also fires `pagehide`/`pageshow` on back/forward cache — may want to handle `pageshow` too for maximum coverage. |

## Validation Strategy

- On mobile Chrome: load the app, switch to another app for 30+ seconds, return — sidebar should show last-known data immediately, then update within 1-2 seconds as re-fetch completes.
- On first load: sidebar should show skeleton rows instead of blank while data is fetching.
- Network offline: sidebar keeps last-known data, no blank flash.
- Run `pnpm build && pnpm typecheck && pnpm lint`.

## Implementation Checklist

- [ ] **1.1** Add `isLoading` state (default `true`) and `hasLoadedOnce` ref to layout.tsx
- [ ] **1.2** Set `isLoading = false` and flip `hasLoadedOnce` after first successful fetch
- [ ] **1.3** In catch block: only clear state if `!hasLoadedOnce.current`, otherwise keep stale data
- [ ] **1.4** Add `visibilitychange` + `pageshow` listeners that call `loadSidebarData()` when tab becomes visible
- [ ] **1.5** Pass `isLoading` as prop to `ProjectSidebar` (and collapsed variant)
- [ ] **2.1** Add `isLoading?: boolean` to `ProjectSidebarProps`
- [ ] **2.2** Create `SidebarSkeleton` component (inline in ProjectSidebar.tsx — 3 grey placeholder rows)
- [ ] **2.3** Create collapsed `SidebarSkeletonCollapsed` (3 grey circle placeholders)
- [ ] **2.4** Render skeleton when `isLoading && projects.length === 0` instead of returning `null`
- [ ] **3** Run `pnpm build && pnpm typecheck && pnpm lint`
- [ ] **4** Open PR against `gb-personal`, link issue
