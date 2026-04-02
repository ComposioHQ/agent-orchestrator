# Feature Plan: Improve UI Loading & Performance

**Issue:** improve-ui-loading
**Branch:** `feat/improve-ui-loading`
**Status:** In Progress (Phases 1-5 implemented, Phase 6 pending)

---

## Problem Summary

The AO web dashboard feels sluggish across multiple user flows:

1. **Tapping a session in the sidebar** — navigation is slow, terminal takes time to appear
2. **Tapping a global terminal** — same sluggish navigation
3. **Spawning a new session** — dialog hangs for 5-10 seconds, then sidebar shows the new session with significant delay
4. **Starting a new terminal** — modal submission blocks with no feedback

The user expectation (benchmarked against code-server/VS Code) is: immediate UI response, progressive loading for data, and no frozen states.

Additionally, all UI customizations should be moved to a separate directory to avoid merge conflicts when rebasing from upstream `main`.

---

## Root Cause Analysis

### Why is everything slow?

The core issue is **synchronous, blocking data fetching** at multiple layers, combined with **aggressive polling** that saturates the API and causes cascading re-renders.

#### 1. Page Load: Server-Side Enrichment Blocks Rendering (3-7s)

**File:** `packages/web/src/app/(with-sidebar)/page.tsx:70-124`

The dashboard page is an async RSC (React Server Component) that:
1. Calls `sessionManager.list()` — fast (~100ms)
2. Calls `enrichSessionsMetadata()` with a **3 second timeout** — this fetches issue titles, agent info
3. Calls `enrichSessionPR()` per PR with a **4 second timeout** (1.5s per individual PR)

The browser shows **nothing** until all this completes. Even with timeouts, the minimum server response time is often 2-4 seconds before the first byte reaches the browser.

**Impact:** Every navigation to the dashboard (including after spawn) waits for full enrichment.

#### 2. Sidebar Data: `Promise.all()` Blocks All Three Endpoints

**File:** `packages/web/src/app/(with-sidebar)/layout.tsx:56-62`

```typescript
const [projectsRes, sessionsRes, terminalsRes] = await Promise.all([
  fetch("/api/projects"),
  fetch("/api/sessions"),   // ← This is the slow one (enrichment)
  fetch("/api/terminals"),
]);
```

The sidebar cannot render **anything** until `/api/sessions` returns. Projects and terminals data is ready in ~50ms but held hostage by session enrichment taking 2-4 seconds.

**Impact:** After initial load, every 10-second poll cycle refetches all three, and the sidebar state updates atomically only when the slowest endpoint returns.

#### 3. Spawn Flow: No Optimistic Update, Full Page Reload

**File:** `packages/web/src/components/SpawnSessionModal.tsx:84-101`

The spawn flow is:
1. `POST /api/spawn` — backend creates session (2-5s: creates worktree, tmux, writes metadata)
2. Wait for response
3. `router.push()` — triggers full page navigation to `/sessions/[id]`
4. New page SSR waits for enrichment again (3-7s)
5. Sidebar poll hasn't fired yet (10s interval), so new session doesn't appear in sidebar

Total time from click to usable state: **5-12 seconds** with no intermediate feedback.

**Impact:** Dialog appears frozen. User doesn't know if it worked.

#### 4. Triple Polling Creates Request Storms

Three independent polling mechanisms compete for the same data:

| Source | Interval | Endpoint | Purpose |
|--------|----------|----------|---------|
| Layout sidebar poll | 10s | `/api/sessions` (full enrichment) | Sidebar session list |
| SSE events route | 5s | `sessionManager.list()` + enrichment | Dashboard real-time updates |
| Session detail page | 5s | `/api/sessions/[id]` | Individual session state |

With 20 sessions, this is ~30+ HTTP requests/minute from a single browser tab. Each `/api/sessions` call triggers metadata + PR enrichment. The server spends most of its time enriching data that hasn't changed.

#### 5. Dashboard Re-render Cascade

**File:** `packages/web/src/components/Dashboard.tsx:80-174`

When any session changes (from SSE or polling), the entire sessions array is replaced. This triggers:
- 8+ `useMemo` recomputations (grouped zones, project overviews, stats, etc.)
- All `SessionCard` components re-render because handler functions (`handleSend`, `handleKill`, etc.) are recreated on each render (new references break `React.memo`)
- The `grouped` object is recreated even if the grouping didn't change

#### 6. Terminal WebSocket: Eager Connection + No Loading State

**File:** `packages/web/src/components/DirectTerminal.tsx:614`

When navigating to a terminal, the WebSocket connects immediately on mount. If the backend isn't ready (race condition after spawn), the component enters an exponential backoff loop. Meanwhile, the user sees a blank screen with no loading indicator.

---

## Proposed Approach

The plan is organized into **6 independent workstreams** that can be implemented incrementally. Each workstream targets a specific bottleneck.

### Workstream 1: Decouple Sidebar from Session Enrichment

**Goal:** Sidebar renders immediately with basic session data; enrichment fills in progressively.

**Approach:**
- Create a new lightweight API endpoint `/api/sessions/light` that returns sessions **without** metadata/PR enrichment — just core fields (id, projectId, status, activity, attentionLevel, createdAt, issueId)
- Sidebar layout fetches `/api/projects`, `/api/sessions/light`, and `/api/terminals` — all fast (<200ms)
- Remove `Promise.all()` gating — use `Promise.allSettled()` with individual state setters so each source renders independently as it arrives
- Keep the existing `/api/sessions` (full enrichment) for the dashboard page only

**Files to modify:**
| File | Change |
|------|--------|
| `packages/web/src/app/api/sessions/light/route.ts` | New endpoint: returns sessions without enrichment |
| `packages/web/src/app/(with-sidebar)/layout.tsx` | Use `/api/sessions/light` for sidebar, render incrementally |

### Workstream 2: Optimistic Spawn with Immediate Sidebar Update

**Goal:** Dialog closes instantly, stub session appears in sidebar, session detail page shows loading skeleton.

**Approach:**
- On spawn submit: immediately close the dialog, insert a **stub session** into sidebar state with status "spawning", navigate to `/sessions/[id]`
- Fire `POST /api/spawn` in the background (not blocking the UI)
- When spawn completes: update the stub with real data via the next poll or a targeted fetch
- If spawn fails: show a toast notification, remove the stub from sidebar
- The session detail page already has a stub mechanism (`createStubSession` in `sessions/[id]/page.tsx`) — extend it to show a "Spawning..." skeleton

**Implementation detail:**
- Add an `onSessionCreated` callback from layout to SpawnSessionModal
- The callback inserts a stub `DashboardSession` into `sessions` state before the API call returns
- Use `navigator.sendBeacon` or fire-and-forget fetch for the spawn call (with error handling via a separate check)

**Files to modify:**
| File | Change |
|------|--------|
| `packages/web/src/components/SpawnSessionModal.tsx` | Close dialog immediately, fire spawn in background |
| `packages/web/src/app/(with-sidebar)/layout.tsx` | Add `onSessionCreated` callback to inject stub session |
| `packages/web/src/app/(with-sidebar)/sessions/[id]/page.tsx` | Enhance stub session with "spawning" loading state |

### Workstream 3: Consolidate Polling into Single SSE Stream

**Goal:** One real-time data channel replaces three competing poll loops.

**Approach:**
- Enhance the existing SSE `/api/events` endpoint to include:
  - Session membership changes (new/removed sessions) with lightweight data
  - Terminal status changes (alive/dead)
  - Spawn completion events
- Remove the 10-second sidebar polling interval from `layout.tsx`
- Remove the 5-second session detail polling from `sessions/[id]/page.tsx`
- The SSE stream becomes the single source of truth for real-time updates
- Keep a fallback: on visibility change (tab becomes visible), do a single fresh fetch

**Polling reduction:** From ~30+ requests/minute down to 1 persistent SSE connection + ~6 snapshot polls/minute server-side.

**Files to modify:**
| File | Change |
|------|--------|
| `packages/web/src/app/api/events/route.ts` | Add membership change + terminal events to SSE |
| `packages/web/src/hooks/useSessionEvents.ts` | Expose terminal/membership events to consumers |
| `packages/web/src/app/(with-sidebar)/layout.tsx` | Replace poll interval with SSE subscription |
| `packages/web/src/app/(with-sidebar)/sessions/[id]/page.tsx` | Replace poll with SSE-driven updates |

### Workstream 4: Fix Dashboard Re-render Cascade

**Goal:** A single session's activity change should only re-render that session's card, not the entire board.

**Approach:**
- Stabilize handler functions in `Dashboard.tsx` using `useCallback` with proper dependencies (or use `useRef` pattern to avoid dependency churn)
- Move `handleSend`, `handleKill`, `handleMerge`, `handleRestore` outside the render cycle — use session ID as parameter, not closure capture
- Use `React.useMemo` more granularly — memoize per-zone session lists by comparing actual session IDs/statuses, not by-reference array equality
- Consider using `Map<sessionId, DashboardSession>` as the primary data structure instead of arrays, to enable O(1) lookups and granular updates

**Files to modify:**
| File | Change |
|------|--------|
| `packages/web/src/components/Dashboard.tsx` | Stabilize handlers, granular memoization |
| `packages/web/src/hooks/useSessionEvents.ts` | Use Map-based state for O(1) session updates |

### Workstream 5: Terminal Navigation — Instant Feedback

**Goal:** When clicking a session or terminal in the sidebar, immediately show a loading skeleton while the terminal connects.

**Approach:**
- Add a terminal loading skeleton component (animated terminal placeholder)
- In `DirectTerminal.tsx`: show skeleton while WebSocket is connecting
- Defer WebSocket connection until the component is actually visible (using `IntersectionObserver` or a `visible` prop)
- Remove the redundant backup resize timers (500ms, 1000ms) — trust `ResizeObserver`
- For the `NewTerminalModal`: use `requestAnimationFrame` instead of `setTimeout(100)` for focus

**Files to modify:**
| File | Change |
|------|--------|
| `packages/web/src/components/DirectTerminal.tsx` | Add loading skeleton, defer WS, clean up resize |
| `packages/web/src/components/NewTerminalModal.tsx` | Fix focus timing |
| `packages/web/src/components/Skeleton.tsx` | Add terminal loading skeleton |

### Workstream 6: Isolate UI Customizations for Upstream Compatibility

**Goal:** Make Phases 1-5 performance fixes upstreamable to `main`, while keeping personal UI customizations (theme, fonts) isolated.

**Key insight:** Moving files to an `ao/` directory creates massive renames that are *impossible* to upstream as a PR. Instead, the right approach is:

1. **Performance fixes (Phases 1-5) stay in existing file paths** — they modify the same files upstream has, making them directly PR-able
2. **Personal customizations** (color palette, font choices, layout preferences) get extracted into a thin **override layer** that can be easily stripped for upstream PRs

**Current state of customizations:**
- `globals.css` — 2059 lines. Most is generic CSS variable *structure* (upstreamable). Personal choices are specific color hex values and font selections.
- Components (Dashboard, Sidebar, etc.) — these ARE the upstream components. Our performance fixes improve them for everyone.

**Approach — Override layer, not file moves:**
- Create `packages/web/src/styles/ao-overrides.css` — personal theme values only
- `globals.css` imports it with a single `@import` line (easy to remove for upstream PRs)
- New files created in Phases 1-5 (e.g., `/api/sessions/light`, `useSSE` hook, `TerminalSkeleton`) are generic and upstream-ready
- Document what's upstreamable vs. personal in `UPSTREAM.md`

**Benefits:**
- Performance PRs to upstream are clean diffs against existing files
- Personal theming is a single CSS file + one import line
- No git rename chaos, no import path rewiring
- Clear for reviewers: "everything except `ao-overrides.css` is upstream-ready"

---

## Risks and Open Questions

| # | Risk/Question | Mitigation |
|---|--------------|------------|
| 1 | **`/api/sessions/light` may diverge from `/api/sessions`** — two endpoints returning sessions with different shapes | Share a common base function, enrichment as optional parameter |
| 2 | **Optimistic spawn could show stale/wrong data** if spawn fails silently | Add error toast + remove stub on failure; background fetch verifies after 3s |
| 3 | **SSE consolidation is a large change** — could break real-time updates | Implement behind a feature flag; keep polling as fallback |
| 4 | **Override extraction** — risk of missing CSS variables when splitting | Automated test: build + visual snapshot comparison before/after |
| 5 | **Upstream PRs need clean diffs** — performance fixes must not include personal customizations | Review each phase's diff against upstream before PR |
| 6 | **Session detail page removing polling** — could miss updates if SSE disconnects | Keep visibility-change fetch as safety net |
| 7 | **Dashboard re-render fix** may change behavior subtly | Run existing E2E tests; manual QA on session status transitions |

---

## Validation Strategy

### Per-workstream validation:
1. **Sidebar decoupling:** Time-to-first-sidebar-render < 500ms (currently 2-4s). Measure with browser DevTools Performance tab.
2. **Optimistic spawn:** Dialog closes < 200ms after click. Session appears in sidebar < 500ms. Measure with user-perceived timing.
3. **Polling consolidation:** Network tab shows 1 SSE connection + ~6 XHR/minute (down from 30+). No stale data regressions.
4. **Re-render fix:** React DevTools Profiler shows only changed SessionCard re-renders on single session update.
5. **Terminal navigation:** Loading skeleton visible within 100ms of click. Terminal usable within 1-2s of navigation.
6. **Directory move:** `pnpm build && pnpm typecheck && pnpm lint` pass. No runtime errors. Visual diff shows zero UI changes.

### Cross-cutting:
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` passes after each workstream
- Manual QA: spawn session, navigate between sessions/terminals, check sidebar updates, theme switching
- No regressions in existing functionality

---

## Implementation Checklist

### Phase 1 — Quick Wins (immediate perceived improvement)

- [x] **1.1** Create `/api/sessions/light` endpoint — returns sessions without metadata/PR enrichment
  - Copy from `/api/sessions/route.ts`, remove `enrichSessionsMetadata` and `enrichSessionPR` calls
  - Return `{ sessions: DashboardSession[] }` with basic fields only
- [x] **1.2** Update `layout.tsx` to use `/api/sessions/light` for sidebar data
  - Replace `/api/sessions` with `/api/sessions/light` in the `loadSidebarData` function
  - Use `Promise.allSettled()` instead of `Promise.all()` to render each source independently
  - Set `isLoading=false` as soon as any response arrives (not all three)
- [x] **1.3** Fix `NewTerminalModal.tsx` focus — replace `setTimeout(100)` with `requestAnimationFrame`
  - Note: The spawn modal already uses `requestAnimationFrame` (line 56) — align the terminal modal
- [x] **1.4** Add terminal loading skeleton to `DirectTerminal.tsx`
  - Show animated placeholder while WebSocket is in "connecting" state
  - Remove the backup `setTimeout` resize handlers (500ms, 1000ms)
- [ ] **1.5** Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test` (build has pre-existing failure with highlight.js CSS import)

### Phase 2 — Optimistic Spawn

- [x] **2.1** Add `onSessionCreated` callback prop to `SpawnSessionModal`
  - The callback receives a stub `DashboardSession` and injects it into layout state
- [x] **2.2** Modify `SpawnSessionModal.handleSubmit`:
  - Close dialog immediately after creating stub
  - Fire `POST /api/spawn` in background (does NOT navigate until real ID returns)
  - On success: navigate to `/sessions/[realId]`
  - On failure: log error (toast deferred)
- [x] **2.3** Update `layout.tsx` to accept `onSessionCreated` and inject stub into `sessions` state
- [ ] **2.4** Add simple toast/notification component for spawn errors (deferred — current impl logs to console)
- [ ] **2.5** Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`

### Phase 3 — Consolidate Polling

- [x] **3.1** Enhance SSE `/api/events` to emit `membership` events (session added/removed)
  - Compare current session IDs with previous snapshot, emit delta
- [x] **3.2** Enhance SSE to emit `terminal` events (terminal alive status changes)
- [ ] **3.3** Create `useSSE` hook that wraps SSE subscription and exposes:
  - `sessions` — current session list (lightweight)
  - `terminals` — current terminal list with alive status
  - `connectionStatus` — connected/reconnecting/disconnected
- [x] **3.4** Update `layout.tsx`:
  - Changed poll interval from 10s to 30s (SSE handles real-time)
  - Added visibility-change fetch as fallback
- [x] **3.5** Update `sessions/[id]/page.tsx`:
  - Reduced polling from 5s to 10s
- [x] **3.6** Reduce SSE server-side poll interval from 5s to 3s (fewer requests, still responsive)
- [ ] **3.7** Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`

### Phase 4 — Fix Dashboard Re-renders

- [x] **4.1** Stabilize handler functions in `Dashboard.tsx`
  - Wrapped `handleSpawnOrchestrator` in `useCallback`
- [ ] **4.2** Optimize `grouped` memoization (deferred — lower priority)
- [ ] **4.3** Verify with React DevTools Profiler that single-session updates only re-render affected cards
- [ ] **4.4** Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`

### Phase 5 — Terminal Loading UX

- [x] **5.1** Add `TerminalSkeleton` component to `Skeleton.tsx`
  - Animated terminal placeholder with fake prompt lines
- [x] **5.2** Update `DirectTerminal.tsx`:
  - Show `TerminalSkeleton` while WebSocket state is "connecting"
  - Transition to real terminal once data starts flowing
  - Remove backup resize `setTimeout` calls
- [ ] **5.3** Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`

### Phase 5b — File Preview Loading UX (added based on user feedback)

- [x] **5b.1** Fix `useFileContent.ts` — clear old data and reset ETag on filePath change; fix 304 handler
- [x] **5b.2** Fix `useDiffContent.ts` — reset ETag on filePath change; fix 304 handler
- [x] **5b.3** Add shimmer skeleton to `FilePreview.tsx` — shows filename + animated lines while loading
- [x] **5b.4** Add shimmer skeleton to `DiffViewer.tsx` — shows filename + animated diff-style lines while loading

### Phase 6 — Isolate UI Customizations for Upstream Compatibility

**Goal:** Make performance improvements (Phases 1-5) easy to upstream to `main`, while keeping
personal UI customizations (theme, layout tweaks) isolated so they don't block upstreaming.

**Key insight:** Moving files into `ao/` creates massive diffs that are impossible to upstream.
Instead, we should:
- Keep files in their **current locations** (same paths as upstream)
- Make performance fixes as **clean, self-contained changes** to existing files — these are directly upstreamable
- Extract **only the personal customizations** (theme colors, layout preferences) into an override layer

**What IS upstreamable (Phases 1-5):**
- `/api/sessions/light` endpoint (new file, no conflict)
- `Promise.allSettled` in layout.tsx (small diff to existing file)
- Optimistic spawn pattern (small diff to SpawnSessionModal.tsx)
- SSE consolidation (diff to events/route.ts + new useSSE hook)
- Dashboard re-render fixes (diff to Dashboard.tsx)
- Terminal loading skeleton (new component + small diff to DirectTerminal.tsx)

**What is NOT upstreamable (personal customizations):**
- Custom CSS theme variables (color choices, fonts)
- Layout tweaks specific to your workflow
- Any feature that only makes sense for your personal fork

**Approach — Override Layer (not file moves):**

- [ ] **6.1** Create `packages/web/src/styles/ao-overrides.css`:
  - Extract personal theme customizations (specific color values, font choices) from `globals.css`
  - `globals.css` keeps the upstream-compatible CSS variable *structure* with default values
  - `ao-overrides.css` overrides just the values you've customized
  - In `globals.css`: add `@import "./styles/ao-overrides.css"` at the end (single line, easy to remove for upstream PR)
- [ ] **6.2** Document upstream vs. personal split in a `packages/web/UPSTREAM.md`:
  - List which files/changes are upstream-ready
  - List which files are personal-only
  - Describe the override pattern for future maintainability
- [ ] **6.3** Ensure all new files from Phases 1-5 follow upstream conventions:
  - No personal branding or opinionated styling in new components
  - Use CSS variables (not hardcoded colors) so they work with any theme
  - Keep new API endpoints generic (not tied to personal workflow)
- [ ] **6.4** Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
- [ ] **6.5** Visual QA: verify zero UI changes after override extraction

### Final

- [ ] Run full validation: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
- [ ] Open PR against `gb-personal`, link issue in description
- [ ] Document performance improvements with before/after metrics

---

## Future Architecture

Phases 1-5 optimize within the current communication model (SSE + per-terminal WebSocket + HTTP polling). The deeper architectural fix is a **persistent multiplexed WebSocket** that replaces all three with a single always-on connection — matching how VS Code/code-server works.

See: `.feature-plans/pending/persistent-multiplexed-websocket.md`

This should be implemented **after** this plan is complete, as it builds on the optimized state (e.g., `/api/sessions/light` feeds the mux session channel).
