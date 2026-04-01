# Feature Plan: Fix Terminal List Background

**Issue:** fix-terminal-list-background
**Branch:** `feat/fix-terminal-list-background`
**Status:** Implemented (PR #847)

---

## Problem Summary

The sidebar background gradient doesn't extend to the bottom of the sidebar where the terminals list is displayed. The terminals section appears without a background, creating a visual gap.

## Research Findings

The sidebar layout is rendered in `packages/web/src/app/(with-sidebar)/layout.tsx` (lines 271-284):

```html
<div class="dashboard-sidebar-desktop">           <!-- display: contents -->
  <div class="flex h-full flex-col">               <!-- wrapper (no bg) -->
    <ProjectSidebar ... />                          <!-- .project-sidebar: has gradient bg + border-right -->
    <TerminalsSidebarSection />                     <!-- plain div: NO background -->
  </div>
</div>
```

The `.project-sidebar` class (in `globals.css` line 1391) applies:
- `border-right: 1px solid var(--color-border-subtle)`
- `background: linear-gradient(...)` (gradient from elevated to base)

The `TerminalsSidebarSection` is a **sibling** of `ProjectSidebar`, not a child. So it doesn't inherit the background. Additionally, `ProjectSidebar` has `h-full` which makes it grow to fill space, pushing the terminals section out of the styled area.

The collapsed sidebar variant (`.project-sidebar--collapsed`) has the same structure issue.

## Proposed Approach

Move the background and border-right from `.project-sidebar` to the parent wrapper div. This ensures the entire sidebar column — including both the project list and the terminals section — gets the background.

1. Add a CSS class (e.g., `sidebar-column`) to the parent `<div className="flex h-full flex-col">` wrapper in both desktop and mobile sidebar renders.
2. In `globals.css`, move the `background` and `border-right` from `.project-sidebar` to `.sidebar-column`.
3. Remove `border-right` and `background` from `.project-sidebar` (keep other styles).
4. Ensure `ProjectSidebar` changes from `h-full` to `flex-1 min-h-0` so it takes remaining space but allows the terminals section to be visible at the bottom.

## Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/app/(with-sidebar)/layout.tsx` | Add `sidebar-column` class to wrapper div (desktop + mobile) |
| `packages/web/src/app/globals.css` | Move `background` and `border-right` from `.project-sidebar` to `.sidebar-column`; adjust `.project-sidebar` to remove those properties |
| `packages/web/src/components/ProjectSidebar.tsx` | Change `h-full` to `flex-1 min-h-0` on the `<aside>` to allow terminals section to show |

## Risks and Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Does moving the background break the collapsed sidebar variant? | Both expanded and collapsed share the same parent wrapper — the fix covers both. |
| 2 | Mobile sidebar rendering? | Mobile sidebar at line 290 has the same structure — apply the same class there too. |

## Validation Strategy

- Visual: sidebar background gradient extends to the very bottom including the terminals list.
- Both expanded and collapsed sidebar variants look correct.
- Mobile sidebar overlay retains correct styling.
- Run `pnpm build && pnpm typecheck && pnpm lint` to verify no breakage.

## Implementation Checklist

- [x] **1** Add `sidebar-column` class to the wrapper `<div>` in layout.tsx (desktop sidebar, line 272)
- [x] **2** Add `sidebar-column` class to the wrapper `<div>` in layout.tsx (mobile sidebar, line 290)
- [x] **3** Add `.sidebar-column` CSS rule in globals.css with background gradient and border-right
- [x] **4** Remove `background` and `border-right` from `.project-sidebar` in globals.css
- [x] **5** Change `h-full` to `flex-1 min-h-0` on the `<aside>` in ProjectSidebar.tsx (expanded, line 405)
- [x] **6** Change `h-full` to `flex-1 min-h-0` on the `<aside>` in ProjectSidebar.tsx (collapsed, line 311)
- [x] **7** Run `pnpm build && pnpm typecheck && pnpm lint`
