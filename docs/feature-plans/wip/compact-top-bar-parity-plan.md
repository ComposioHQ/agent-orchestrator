# Compact Top Bar Parity Plan (Project + All Projects)

## Goal
Replace the large header bars on the project and all-projects pages with the same compact top-bar experience used on the session workspace view, including the sidebar collapsed/expanded toggle behavior and mobile overlay behavior.

## Scope
- In scope:
  - **All dashboard variants** that currently render the large `dashboard-hero` header in `Dashboard`, including:
    - **Single-project default** (`/` with one configured project, or any path where `Dashboard` shows the hero with a concrete `projectName`).
    - **Explicit project** (`/?project=<id>` when multiple projects exist).
    - **All projects** (`/?project=all` or the multi-project “overview” mode when `projects.length > 1 && projectId === undefined` — see `allProjectsView` in `Dashboard.tsx`).
  - Sidebar toggle parity (desktop collapse + mobile overlay) from the session workspace top bar.
  - Mobile responsive parity for the compact bar across these screens.
- Out of scope:
  - New product features unrelated to top-bar/header parity.
  - Rework of session classic view.

### Surfaces (do not assume only `?project=all`)
Implementation must cover **every** `Dashboard` render inside `(with-sidebar)` that still uses the hero, not only the all-projects grid. If `ProjectSidebar` is hidden (`projects.length <= 1`), the compact bar still applies to the main content header for consistency.

## Source-of-Truth Behavior to Replicate
- Use the existing session workspace implementation as canonical:
  - `components/workspace/CompactTopBar.tsx`
  - `components/workspace/WorkspaceLayout.tsx`
  - `(with-sidebar)/layout.tsx` sidebar state and toggle logic
  - `components/workspace/workspace.css` compact bar responsive rules
- Sidebar toggle semantics must stay identical:
  - Desktop: collapse/expand persistent sidebar (`sidebarCollapsed` + `localStorage` in layout).
  - Mobile: open/close sidebar overlay (`mobileSidebarOpen`, `window.innerWidth <= 640` in `toggleSidebar`).

## Implementation Plan

### 1) Baseline and contract extraction
- Define a small shared "compact top bar contract" from current session behavior:
  - **Left:** sidebar toggle (from `useSidebarContext().onToggleSidebar` on dashboard); **optional back** only where it makes sense.
  - **Center:** title and optional subtitle/metadata rows (dashboard: project name + short tagline or stats summary).
  - **Right:** existing dashboard hero controls, with explicit priority (see below).
- **Dashboard vs session:** Omit the session workspace **back** control (`←` / `router.back()`) on the home/dashboard routes — there is no meaningful “back” target and it would diverge from dashboard UX. Session workspace keeps back unchanged.
- Keep session-specific fields (activity/branch/PR/CI) optional so session behavior remains unchanged.

### 2) Introduce reusable compact top bar path for dashboard screens
- `CompactTopBar` today requires workspace-only props (`session`, pane `collapsed`/`toggleCollapsed`, `verticalLayout`, etc.). Do **not** force dashboard to pass dummy pane state; prefer:
  - a **shared shell** component (e.g. layout + sidebar button + slots), or
  - a **`variant`** on `CompactTopBar` with workspace and `dashboard` prop shapes, keeping the workspace code path byte-identical where possible.
- Ensure the sidebar toggle still consumes `SidebarContext` so behavior remains centralized in `(with-sidebar)/layout.tsx` (no duplicate mobile/desktop branching in `Dashboard`).

### 3) Replace large dashboard hero/header blocks
- Migrate the dashboard top region (`Dashboard` project and all-projects variants) from hero-style header to compact top bar.
- Preserve existing controls and signals by placing them in the right / secondary area, with this **priority** (highest first):
  1. **Theme toggle** — always keep accessible.
  2. **Orchestrator control** — show when `!allProjectsView` (same rule as today).
  3. **Status cards / fleet metrics** — may wrap to a second row or shrink on narrow widths; hide or collapse lowest-priority numbers only if needed to avoid overflow (match session bar philosophy: truncate/hide dense metadata on small screens).
- Keep board content below the bar unchanged unless required for spacing/layout continuity (e.g. remove `mb-5` hero margin equivalents).

### 4) CSS and responsive parity
- Reuse existing compact top-bar classes (`.compact-top-bar`, `.compact-top-bar__*`) from `components/workspace/workspace.css`.
- **Stylesheet wiring:** `workspace.css` is imported today by `WorkspaceLayout` only. The dashboard does **not** load it. After extraction, ensure dashboard (or a shared parent) imports the **minimal** CSS needed for the compact bar (options: small `compact-top-bar.css` imported by both; or move compact-bar rules to `globals.css`; avoid pulling the entire workspace IDE stylesheet into dashboard if it causes unrelated side effects).
- Remove or neutralize conflicting hero-only spacing on dashboard screens after migration (`dashboard-hero`, outer `py-*` on the main column if the bar is fixed height).
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
  - **Single-project** dashboard (`/` or equivalent) shows compact top bar (no `dashboard-hero`).
  - **Per-project** dashboard shows compact top bar.
  - **All-projects** overview shows compact top bar.
  - Sidebar toggle on each of the above collapses/expands the desktop sidebar exactly like session workspace.
  - **No back arrow** on dashboard compact bar (session workspace still has back).
- Mobile:
  - same toggle opens/closes sidebar overlay on **all** dashboard modes above.
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
  - Mitigation: keep session/workspace prop path untouched or isolated behind an explicit `variant`; snapshot or manual compare `/sessions/[id]` before/after.
- Risk: dashboard controls become cramped on mobile.
  - Mitigation: use the **priority list** in section 3; allow stats to wrap or defer to scroll; do not drop theme toggle.
- Risk: compact bar renders **unstyled** on dashboard because `workspace.css` was never imported there.
  - Mitigation: explicit shared CSS import or extracted compact-bar stylesheet (section 4).
- Risk: duplicate sidebar toggle state logic across components.
  - Mitigation: only use `SidebarContext` callbacks from layout; avoid local duplicated state.
