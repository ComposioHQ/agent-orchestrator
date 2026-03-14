---
phase: 01-shared-dashboard-foundation
plan: 01
subsystem: ui
tags: [nextjs, dashboard, sse, routing, shared-payload]
requires: []
provides:
  - shared dashboard payload builder for SSR and refresh responses
  - canonical dashboard route-state parsing and href generation
  - mode-safe live refresh contract shared by legacy and pixel views
affects: [phase-01-plan-02, phase-02-pixel-world-core]
tech-stack:
  added: []
  patterns: [shared server payload builder, canonical query-state helper, mode-safe refresh contract]
key-files:
  created:
    - packages/web/src/lib/dashboard-data.ts
    - packages/web/src/lib/dashboard-route-state.ts
  modified:
    - packages/web/src/app/page.tsx
    - packages/web/src/app/api/sessions/route.ts
    - packages/web/src/components/Dashboard.tsx
    - packages/web/src/components/ProjectSidebar.tsx
    - packages/web/src/hooks/useSessionEvents.ts
    - packages/web/src/lib/types.ts
key-decisions:
  - "Use one shared server-side builder for both the page route and /api/sessions so session enrichment cannot drift by renderer."
  - "Treat legacy as the canonical default view and omit `view=legacy` from generated dashboard URLs."
  - "Thread dashboard view through refresh responses without introducing a pixel-specific session shape."
patterns-established:
  - "Dashboard payload assembly lives in `packages/web/src/lib/dashboard-data.ts` and feeds both SSR and refresh paths."
  - "Dashboard URL writes go through `packages/web/src/lib/dashboard-route-state.ts` so `project` and `view` stay in sync."
requirements-completed: [NAV-02, LIVE-01, LIVE-02]
duration: 4min
completed: 2026-03-14
---

# Phase 1 Plan 1: Shared Dashboard Foundation Summary

**Shared dashboard payload assembly and URL-backed view state for legacy and pixel modes without forking the live session contract**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-14T17:33:00Z
- **Completed:** 2026-03-14T17:37:25Z
- **Tasks:** 3
- **Files modified:** 12

## Accomplishments
- Extracted shared dashboard payload assembly into `dashboard-data.ts` and reused it from both `page.tsx` and `/api/sessions`.
- Added canonical dashboard route-state helpers plus sidebar coverage so `project` survives view-aware URL updates.
- Threaded `view` through the refresh contract and tests without introducing a pixel-only backend payload.

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract shared dashboard payload assembly** - `db75a61` (feat)
2. **Task 2: Introduce canonical dashboard route-state helpers** - `e34ed00` (feat)
3. **Task 3: Keep the live contract stable for both renderers** - `6803659` (feat)

**Verification fix:** `8e20c1f` (fix: resolve dashboard foundation typecheck blockers)

## Files Created/Modified
- `packages/web/src/lib/dashboard-data.ts` - Shared SSR and refresh payload builder for sessions, PR enrichment, orchestrators, stats, and global pause.
- `packages/web/src/lib/dashboard-route-state.ts` - Canonical parser and href writer for `project` plus `view`.
- `packages/web/src/app/page.tsx` - Uses the shared payload builder and route-state parsing for initial dashboard render.
- `packages/web/src/app/api/sessions/route.ts` - Reuses the shared payload builder and returns typed `view` with refresh payloads.
- `packages/web/src/components/ProjectSidebar.tsx` - Preserves current view state while changing project scope.
- `packages/web/src/components/Dashboard.tsx` - Passes view through live refresh logic and all-project project links.
- `packages/web/src/hooks/useSessionEvents.ts` - Keeps membership refreshes on the current dashboard view.

## Decisions Made
- Used one server payload builder for both SSR and refresh so future legacy/pixel renderers share enrichment logic by construction.
- Kept `legacy` as the implicit default view so canonical dashboard URLs stay short and existing routes remain valid.
- Added only typed `view` metadata to the shared payload instead of creating a renderer-specific session contract.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Cleared stale Next type artifacts during verification**
- **Found during:** Final verification
- **Issue:** `pnpm --filter @composio/ao-web typecheck` was blocked by stale `.next/types/validator.ts` references to removed `pixel-agents` routes, and the new route-state/type additions surfaced two source-level typing issues.
- **Fix:** Tightened route-state search-param narrowing, imported `GlobalPauseState` locally for the shared payload interface, and ran the package `clean` script before re-running typecheck.
- **Files modified:** `packages/web/src/lib/dashboard-route-state.ts`, `packages/web/src/lib/types.ts`
- **Verification:** `pnpm --filter @composio/ao-web typecheck`
- **Committed in:** `8e20c1f`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Verification-only fix. No scope creep and no contract changes beyond making the planned work type-safe.

## Issues Encountered
None beyond the stale generated Next validator artifact resolved during verification.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 1 now has a shared backend/data seam and canonical route-state helper for the visible mode switcher and shell work in Plan 01-02.
- The refresh contract remains shared across renderers, so Phase 2 can build the pixel body on top of existing live session semantics instead of adding a second stream.

## Self-Check: PASSED
- Summary file exists on disk.
- Task and verification commits `db75a61`, `e34ed00`, `6803659`, and `8e20c1f` are present in git history.
