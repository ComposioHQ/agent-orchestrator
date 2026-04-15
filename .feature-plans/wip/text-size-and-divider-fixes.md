# Feature Plan: Text Size Option in File Preview + Divider & Terminal Fixes

**Issue:** text-size
**Branch:** `feat/text-size`
**Status:** Pending

---

## Problem

- No text size control in the file preview / diff viewer — font size is hardcoded to 13px
- Terminal doesn't refresh to the new size when text size is changed (must nudge resize manually)
- Vertical layout divider bugs: horizontal divider moves faster than finger, and moving the vertical divider to top causes the horizontal divider to shift

## Research

### File Preview (Code Viewer)

- **File:** `packages/web/src/components/workspace/FilePreview.tsx:37-61`
- `CodeViewer` renders a `<pre className="workspace-code-viewer">` with hardcoded `font-size: 13px` via CSS
- **CSS:** `packages/web/src/components/workspace/workspace.css:226-232`
- Line height hardcoded to `20px`

### File Preview (Diff Viewer)

- **File:** `packages/web/src/components/workspace/DiffViewer.tsx:118-140`
- `DiffViewer` renders `<pre className="workspace-diff-viewer">` with hardcoded `font-size: 13px` via CSS
- **CSS:** `packages/web/src/components/workspace/workspace.css:724-731`
- Gutter font-size hardcoded to `12px` at `workspace.css:763`

### File Preview (Markdown)

- **CSS:** `packages/web/src/components/workspace/workspace.css:302+`
- Base font-size: 14px, headings have their own sizes
- Markdown scaling should be relative to base too

### Terminal Font Size Change

- **File:** `packages/web/src/components/DirectTerminalGB.tsx:226-238`
- `handleFontSizeChange` updates `terminal.options.fontSize` then calls `fitTerminal()`
- `fitTerminal()` at `DirectTerminalGB.tsx:32-61` calls `fit.fit()` then verifies with `getBoundingClientRect`
- **Bug:** After `fit.fit()`, the terminal needs `terminal.refresh(0, terminal.rows - 1)` to repaint with the new cell dimensions — without it the display is stale until something else triggers a repaint
- The `ResizeObserver` at `DirectTerminalGB.tsx:577-582` watches the container, but font size changes don't change container size, so the observer doesn't fire

### Vertical Layout Divider Coupling (Root Cause of Both Divider Bugs)

- **File:** `packages/web/src/components/workspace/WorkspaceLayout.tsx:239-285`
- `sizes` array: `[files%, preview%, terminal%]` — 3 values shared across both axes
- In vertical layout:
  - Separator 0 (column split: file tree | preview): adjusts `sizes[0]` and `sizes[1]`
  - Separator 1 (row split: top | terminal): adjusts `sizes[1]` and `sizes[2]`
- **Column template** uses `sizes[0]` and `sizes[1]` — `WorkspaceLayout.tsx:336-341`
- **Row template** uses `sizes[0]+sizes[1]` and `sizes[2]` — `WorkspaceLayout.tsx:328-334`
- **Bug:** `sizes[1]` is shared between both separators
  - Dragging the row separator (sep 1) changes `sizes[1]`, which also changes the column split → "horizontal divider moves out of nowhere"
  - The column change adds to the visual movement, making the row separator feel like it "moves faster than the finger"
- **Risk:** HIGH — this is a fundamental data coupling issue

### Container Reference in Vertical Layout

- **File:** `WorkspaceLayout.tsx:518-519`
- `containerRef` is on the outer grid div
- Separator 0 (column split) is inside the inner top div at line 522, but `containerSize` uses the outer container width — this is actually correct since inner div spans full width
- Separator 1 (row split) uses outer container height — also correct

## Root Cause

- **Text size in preview:** No control exists; font sizes are hardcoded in CSS
- **Terminal refresh:** `fitTerminal()` doesn't call `terminal.refresh()` after resizing — the rendered glyph grid is stale
- **Divider coupling:** In vertical layout, `sizes[1]` (preview) is used by both separators, causing cross-axis interference when dragging either separator

## Approach

### Fix 1: Preview Text Size Control

- Add a CSS custom property `--preview-font-size` on the preview scroll container
- Use CSS `calc()` for line-height: `calc(var(--preview-font-size) * 1.54)` (preserves 13→20 ratio)
- Store preference in localStorage key `"ao:workspace:preview-font-size"`
- Add a text size button (Aa icon) in the PREVIEW pane header with a popover slider (same pattern as DirectTerminalGB's font settings)
- CSS selectors `.workspace-code-viewer`, `.workspace-diff-viewer`, `.workspace-markdown-preview` inherit the variable
- Range: 10px–18px, default 13px, step 1

### Fix 2: Terminal Refresh on Font Size Change

- In `fitTerminal()` (`DirectTerminalGB.tsx:32-61`), add `terminal.refresh(0, terminal.rows - 1)` after the resize to force a repaint
- This ensures the terminal redraws all cells with the new font metrics

### Fix 3: Decouple Vertical Layout Dividers

- Add a 4th size value `verticalSplit` to `usePaneSizes` state — controls the row split (top vs terminal) independently
- In vertical layout:
  - Column split (separator 0): still uses `sizes[0]` and `sizes[1]` — no change
  - Row split (separator 1): uses `verticalSplit` (a [topPct, bottomPct] pair) instead of overloading `sizes[1]`/`sizes[2]`
- `getVerticalRowTemplate()` uses `verticalSplit` instead of `sizes[0]+sizes[1]` and `sizes[2]`
- `handleDragStart` needs a branch: when in vertical layout and separatorIndex === 1, update `verticalSplit` instead of `sizes`
- Persisted to localStorage alongside existing state

## Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/components/workspace/WorkspaceLayout.tsx` | Add preview text size state, button, popover; decouple vertical separator logic |
| `packages/web/src/components/workspace/workspace.css` | Add `--preview-font-size` variable usage in code-viewer, diff-viewer, markdown-preview classes; popover styles for text size control |
| `packages/web/src/components/workspace/usePaneSizes.ts` | Add `verticalSplit` to state, persistence, setter |
| `packages/web/src/components/DirectTerminalGB.tsx` | Add `terminal.refresh()` call in `fitTerminal()` |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Should text size also scale markdown headings?** | Yes — use relative sizing so headings scale proportionally with the base |
| 2 | **Does `terminal.refresh()` cause visual flicker?** | No — refresh repaints from the existing buffer; it's the standard way to update after option changes |
| 3 | **Will adding `verticalSplit` break existing localStorage data?** | No — `usePaneSizes` will fall back to defaults when `verticalSplit` is absent, same as current behavior |
| 4 | **Should preview and terminal share the same font size?** | No — they serve different purposes (reading code vs interacting with a terminal), keep separate controls |

## Validation

- Manual test: change preview text size, verify code viewer, diff viewer, and markdown all scale
- Manual test: change terminal font size, verify terminal repaints immediately without needing resize nudge
- Manual test: in vertical layout, drag row separator → column split must not change
- Manual test: in vertical layout, drag column separator → row split must not change
- Manual test: reload page → verify both preview font size and pane sizes persist
- Existing tests: `pnpm --filter @composio/ao-web test` must pass
- Typecheck: `pnpm typecheck` must pass

## Checklist

### Phase 1 — Preview Text Size Control

- [ ] **1.1** Add localStorage helper functions for preview font size in `WorkspaceLayout.tsx` (or a small utility)
- [ ] **1.2** Add state + popover UI for text size in the PREVIEW pane header
- [ ] **1.3** Pass `--preview-font-size` as inline CSS variable on the preview scroll container
- [ ] **1.4** Update `workspace.css`: `.workspace-code-viewer`, `.workspace-diff-viewer` font-size → `var(--preview-font-size, 13px)`, line-height → `calc(var(--preview-font-size, 13px) * 1.54)`
- [ ] **1.5** Update `workspace.css`: `.workspace-markdown-preview` base font-size → `calc(var(--preview-font-size, 13px) + 1px)` and heading sizes → relative `em` values
- [ ] **1.6** Update diff gutter font-size to be relative: `calc(var(--preview-font-size, 13px) - 1px)`

### Phase 2 — Terminal Refresh Fix

- [ ] **2.1** In `fitTerminal()` at `DirectTerminalGB.tsx`, add `terminal.refresh(0, terminal.rows - 1)` after the resize/fit logic

### Phase 3 — Decouple Vertical Layout Dividers

- [ ] **3.1** Add `verticalSplit?: [number, number]` to `PaneSizesState` in `usePaneSizes.ts`, with default `[60, 40]`
- [ ] **3.2** Add `setVerticalSplit` setter in `usePaneSizes` (persists to localStorage)
- [ ] **3.3** In `WorkspaceLayout.tsx`, consume `verticalSplit` / `setVerticalSplit` from the hook
- [ ] **3.4** Update `getVerticalRowTemplate()` to use `verticalSplit` instead of `sizes[0]+sizes[1]` / `sizes[2]`
- [ ] **3.5** In `handleDragStart`, when vertical layout and separator index is 1 (row split), update `verticalSplit` instead of `sizes`
- [ ] **3.6** Verify column separator (index 0) still works correctly — only touches `sizes[0]`/`sizes[1]`

### Phase 4 — Build & Test

- [ ] **4.1** Run `pnpm build && pnpm typecheck && pnpm lint`
- [ ] **4.2** Run `pnpm --filter @composio/ao-web test`
- [ ] **4.3** Manual testing of all 3 features
