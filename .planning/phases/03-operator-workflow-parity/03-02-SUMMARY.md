---
phase: 03-operator-workflow-parity
plan: 02
subsystem: ui
tags: [react, nextjs, vitest, dashboard, pixel-mode]
requires:
  - phase: 03-operator-workflow-parity/03-01
    provides: inspect drawer layout, selected-session detail surfaces, project context block
provides:
  - pixel drawer actions for send, kill, restore, and merge
  - shared action predicates and quick prompts reused across legacy and pixel views
  - targeted parity tests for drawer behavior and action routes
affects: [legacy-dashboard, pixel-dashboard, api-routes, operator-parity]
tech-stack:
  added: []
  patterns: [shared action predicate helpers, drawer-scoped action feedback, route-backed executor wrappers]
key-files:
  created: [packages/web/src/components/session-actions.ts, packages/web/src/components/__tests__/SessionCard.test.tsx]
  modified: [packages/web/src/components/Dashboard.tsx, packages/web/src/components/SessionCard.tsx, packages/web/src/components/pixel-dashboard/PixelDashboardView.tsx, packages/web/src/components/pixel-dashboard/PixelSessionDrawer.tsx, packages/web/src/components/pixel-dashboard/pixel-session-drawer.tsx, packages/web/src/components/pixel-dashboard/__tests__/PixelDashboardView.test.tsx, packages/web/src/__tests__/api-routes.test.ts]
key-decisions:
  - "Keep fetch execution in Dashboard, but expose raw route-backed executors to pixel mode so the drawer can own confirmations and local feedback."
  - "Extract quick prompts and availability rules into a shared helper module so legacy and pixel surfaces derive action affordances from the same session and PR semantics."
patterns-established:
  - "Pattern 1: Shared operator actions return promise-based success or throw route-derived errors, while each surface decides how to present confirmation and feedback."
  - "Pattern 2: Pixel drawer send stays disabled until a quick prompt is chosen or a concrete typed message is entered."
requirements-completed: [ACT-01, ACT-02, ACT-03, ACT-04]
duration: 9 min
completed: 2026-03-14
---

# Phase 3 Plan 2: Operator Action Parity Summary

**Pixel drawer actions now reuse shared session and PR semantics to send messages, kill, restore, and merge with local confirmation and feedback.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-03-14T20:39:00Z
- **Completed:** 2026-03-14T20:48:13Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- Routed pixel mode through the same send, kill, restore, and merge executors already owned by `Dashboard.tsx`.
- Added a drawer-scoped action bar with explicit message selection, merge/kill confirmation, and visible success/error feedback.
- Locked the parity behavior with focused drawer, shared-helper, and route tests.

## Task Commits

Each task was committed atomically:

1. **Task 1: Expose the shared action handlers and parity availability rules to pixel mode** - `fedf13d` (feat)
2. **Task 2: Build the drawer-header action bar with confirmations and inline feedback** - `1ab2a34` (test)
3. **Task 3: Lock parity behavior with targeted component and route coverage** - `04bdc3a` (test)

## Files Created/Modified

- `packages/web/src/components/session-actions.ts` - Shared action availability and quick-prompt helpers reused by legacy and pixel surfaces.
- `packages/web/src/components/Dashboard.tsx` - Raw route-backed executors plus legacy wrappers for confirmation-preserving behavior.
- `packages/web/src/components/SessionCard.tsx` - Rewired legacy card to shared predicates instead of inline action logic.
- `packages/web/src/components/pixel-dashboard/PixelDashboardView.tsx` - Threaded shared action handlers into pixel mode.
- `packages/web/src/components/pixel-dashboard/PixelSessionDrawer.tsx` - Passed action handlers into the selected-session drawer.
- `packages/web/src/components/pixel-dashboard/pixel-session-drawer.tsx` - Added the drawer action bar, prompt selection, confirmations, and inline feedback states.
- `packages/web/src/components/pixel-dashboard/__tests__/PixelDashboardView.test.tsx` - Covered send payload gating, merge confirmation, success feedback, and rate-limit disablement.
- `packages/web/src/components/__tests__/SessionCard.test.tsx` - Covered shared quick prompts and rate-limited merge suppression.
- `packages/web/src/__tests__/api-routes.test.ts` - Covered send sanitization and merge blocker passthrough.

## Decisions Made

- Kept the raw mutation work in `Dashboard.tsx` so pixel mode consumes the same operational contract as legacy mode.
- Left drawer confirmation and feedback local to pixel mode instead of pushing UI state into shared route handlers.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- A broad `pnpm --filter @composio/ao-web test -- components` run still includes unrelated pre-existing failures in dashboard router-mocking and duplicate-text assertions outside the files owned by this plan. Verification used targeted owned-file suites plus `typecheck`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 3 is complete and Phase 4 can build on the now-parity action drawer.
- Manual browser verification for the drawer interaction feel is still pending.

## Self-Check: PASSED

- Verified `.planning/phases/03-operator-workflow-parity/03-02-SUMMARY.md` exists.
- Verified task commits `fedf13d`, `1ab2a34`, and `04bdc3a` exist in git history.
