---
phase: 01-shared-dashboard-foundation
plan: 02
subsystem: ui
tags: [react, nextjs, dashboard, shell, pixel-mode]
requires:
  - phase: 01-shared-dashboard-foundation
    provides: shared payload builder and canonical route-state helpers
provides:
  - shared dashboard shell with visible legacy and pixel mode switching
  - extracted legacy renderer boundary hosted inside the shared shell
  - bounded phase-1 pixel dashboard body for single-project and all-project states
affects: [phase-02-pixel-world-core, phase-03-operator-workflow-parity]
tech-stack:
  added: []
  patterns: [shared shell with renderer views, url-backed mode switcher, bounded pixel district preview]
key-files:
  created:
    - packages/web/src/components/dashboard-shell/DashboardModeSwitcher.tsx
    - packages/web/src/components/dashboard-shell/DashboardShell.tsx
    - packages/web/src/components/legacy-dashboard/LegacyDashboardView.tsx
    - packages/web/src/components/pixel-dashboard/PixelDashboardView.tsx
  modified:
    - packages/web/src/components/Dashboard.tsx
    - packages/web/src/components/__tests__/Dashboard.projectOverview.test.tsx
key-decisions:
  - "Keep the shell responsible for chrome, alerts, orchestrator controls, and mode switching while each renderer owns only its body."
  - "Route dashboard mode changes through canonical href helpers so project scope survives every view switch."
  - "Ship a bounded pixel district preview in Phase 1 rather than taking on Phase 2 canvas rendering scope."
patterns-established:
  - "Dashboard.tsx orchestrates shared live state and delegates rendering to shell/body components."
  - "Dashboard mode switching is a top-level shell concern backed by URL state."
requirements-completed: [NAV-01, NAV-03, LIVE-01, LIVE-02]
duration: 7min
completed: 2026-03-14
---

# Phase 1 Plan 2: Shared Dashboard Shell Summary

**Shared dashboard shell with a visible mode switcher, extracted legacy body, and bounded pixel district previews for both scoped and all-project views**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-14T17:37:45Z
- **Completed:** 2026-03-14T17:44:00Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments
- Extracted the dashboard chrome into a reusable shell with a visible legacy/pixel mode switcher and preserved orchestrator controls.
- Split the legacy renderer into its own view component so the shell can host multiple bodies without changing live-state wiring.
- Added a bounded pixel-mode body that presents project districts in all-project mode and attention lanes in scoped mode without absorbing Phase 2 world-rendering scope.

## Task Commits

Each task was committed atomically where the file boundaries allowed:

1. **Task 1-3: Shared shell, URL-backed switcher, and bounded pixel body** - `2092020` (feat)

_Note: The renderer-boundary refactor touched the same top-level dashboard files across all three tasks, so the implementation was committed as one focused integration change instead of three partial-file commits._

## Files Created/Modified
- `packages/web/src/components/Dashboard.tsx` - Coordinates live state and hands rendering to shared shell plus renderer bodies.
- `packages/web/src/components/dashboard-shell/DashboardShell.tsx` - Shared dashboard chrome, status banners, and orchestrator controls.
- `packages/web/src/components/dashboard-shell/DashboardModeSwitcher.tsx` - Visible top-level mode switcher backed by dashboard URL state.
- `packages/web/src/components/legacy-dashboard/LegacyDashboardView.tsx` - Extracted legacy renderer boundary with existing overview, kanban, and PR surfaces.
- `packages/web/src/components/pixel-dashboard/PixelDashboardView.tsx` - Phase 1 pixel district preview for scoped and all-project views.
- `packages/web/src/components/__tests__/Dashboard.projectOverview.test.tsx` - Covers view switching and pixel district rendering.

## Decisions Made
- Kept all shared chrome in the shell so future dashboard modes can swap bodies without reimplementing alerts, stats, or orchestrator controls.
- Used explicit tab-style mode switching in the shell to make the second dashboard mode discoverable instead of relying on hidden deep links.
- Limited Phase 1 pixel rendering to grouped district previews and attention lanes so Phase 2 still owns the canvas/world model.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Integration] Consolidated the three UI tasks into one commit**
- **Found during:** Implementation
- **Issue:** Task boundaries overlapped heavily in `Dashboard.tsx` and the new shell components, making isolated file-level commits misleading.
- **Fix:** Landed the shell extraction, mode switcher wiring, and bounded pixel body together as one integration commit after full targeted verification.
- **Files modified:** `packages/web/src/components/Dashboard.tsx`, `packages/web/src/components/dashboard-shell/*`, `packages/web/src/components/legacy-dashboard/LegacyDashboardView.tsx`, `packages/web/src/components/pixel-dashboard/PixelDashboardView.tsx`
- **Verification:** `pnpm --filter @composio/ao-web test -- ProjectSidebar Dashboard.projectOverview useSessionEvents`; `pnpm --filter @composio/ao-web typecheck`
- **Committed in:** `2092020`

---

**Total deviations:** 1 auto-fixed (1 integration)
**Impact on plan:** No scope creep. The code still maps cleanly to the planned tasks, but the commit history is one integration step instead of three partial-file commits.

## Issues Encountered
None after the shell split; targeted tests and typecheck passed on the first verification cycle after one local typing fix in `Dashboard.tsx`.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 1 now exposes a shared shell seam and a visible pixel entrypoint that Phase 2 can replace with a real world renderer.
- URL semantics, live refresh behavior, and project scoping are already shared across legacy and pixel mode, reducing Phase 2 to body-level rendering work.

## Self-Check: PASSED
- Summary file exists on disk.
- Feature commit `2092020` is present in git history.
- Targeted dashboard tests and package typecheck pass.
