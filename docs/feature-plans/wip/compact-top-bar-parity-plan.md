# Compact Top Bar Parity Plan (Project + All Projects)

## Goal
Replace the large header bars on the project and all-projects pages with the same compact top-bar experience used on the session workspace view, including the sidebar collapsed/expanded toggle behavior and mobile overlay behavior.

## Scope
- In scope:
  - Project dashboard view header replacement.
  - All-projects dashboard view header replacement.
  - Sidebar toggle parity (desktop collapse + mobile overlay) from the session workspace top bar.
  - Mobile responsive parity for the compact bar across these screens.
- Out of scope:
  - New product features unrelated to top-bar/header parity.
  - Rework of session classic view.

## Source-of-Truth Behavior to Replicate
- Use the existing session workspace implementation as canonical:
  - `components/workspace/CompactTopBar.tsx`
  - `components/workspace/WorkspaceLayout.tsx`
  - `(with-sidebar)/layout.tsx` sidebar state and toggle logic
  - `components/workspace/workspace.css` compact bar responsive rules
- Sidebar toggle semantics must stay identical:
  - Desktop: collapse/expand persistent sidebar.
  - Mobile: open/close sidebar overlay.

## Implementation Plan

### 1) Baseline and contract extraction
- Define a small shared "compact top bar contract" from current session behavior:
  - left control area (sidebar toggle, optional back button)
  - center info area (title and optional metadata rows)
  - right action area (existing dashboard controls)
- Keep session-specific fields (activity/branch/PR/CI) optional so session behavior remains unchanged.

### 2) Introduce reusable compact top bar path for dashboard screens
- Either:
  - extend `CompactTopBar` with a mode for non-session pages, or
  - create a shared compact top bar wrapper used by both session workspace and dashboard pages.
- Ensure the sidebar toggle still consumes `SidebarContext` so behavior remains centralized in `(with-sidebar)/layout.tsx`.

### 3) Replace large dashboard hero/header blocks
- Migrate the dashboard top region (`Dashboard` project and all-projects variants) from hero-style header to compact top bar.
- Preserve existing controls and signals (theme toggle, orchestrator control, key metrics) by placing them into compact bar action/meta slots.
- Keep board content below the bar unchanged unless required for spacing/layout continuity.

### 4) CSS and responsive parity
- Reuse existing compact top-bar classes/rules where possible to avoid divergence.
- Remove or neutralize conflicting hero-only spacing on dashboard screens after migration.
- Ensure mobile behavior matches session compact bar:
  - proper truncation/wrapping,
  - hidden low-priority metadata at small widths,
  - no clipped or untappable controls.

### 5) Regression safety (session-first)
- Explicitly guard against session regressions:
  - `/sessions/[id]` workspace top bar remains visually and behaviorally identical.
  - pane toggle controls and sidebar toggle in workspace remain unchanged.
  - `?view=classic` session flow remains unaffected.

## Verification Checklist
- Desktop:
  - project page shows compact top bar (no large hero header).
  - all-projects page shows compact top bar (no large hero header).
  - sidebar toggle in both screens collapses/expands sidebar exactly like session workspace.
- Mobile:
  - same toggle opens/closes sidebar overlay on project and all-projects pages.
  - route navigation closes overlay as currently implemented.
  - compact bar content remains usable and non-overflowing.
- Session regression:
  - session workspace top bar unchanged in layout and interactions.
  - session-specific metadata rendering still correct.
- Final validation:
  - targeted UI checks for compact bar + sidebar parity across three surfaces:
    - session workspace
    - project dashboard
    - all-projects dashboard

## Risks and Mitigations
- Risk: unintentionally changing session top bar behavior while generalizing component.
  - Mitigation: keep session prop path untouched or feature-flagged by explicit variant props.
- Risk: dashboard controls become cramped on mobile.
  - Mitigation: define priority ordering for controls and hide low-priority metadata at narrow widths.
- Risk: duplicate sidebar toggle state logic across components.
  - Mitigation: only use `SidebarContext` callbacks from layout; avoid local duplicated state.
