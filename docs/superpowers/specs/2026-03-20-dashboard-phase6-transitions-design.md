# Dashboard Phase 6 — Transitions & Animations Design

**Issue:** #555
**Date:** 2026-03-20
**Part of:** #549 Dashboard UI Overhaul

## Scope

Four areas of work, all CSS-only (no Framer Motion):

1. Standardize transition tokens
2. Theme-toggle transition prep
3. Page entrance animations
4. Kanban drag-and-drop visual feedback

## 1. Transition Token Standardization

### Problem
`globals.css` defines `--transition-quick: 0.1s` and `--transition-regular: 0.25s`, but `.session-card` and `.orchestrator-btn` both use hardcoded `0.12s`. Inline Tailwind `transition-colors` and `duration-[100ms]` in components are also unaligned.

### Solution
Add `--transition-fast: 0.12s` to `@theme` — this captures the existing card/button timing as a named token. Update `.session-card` and `.orchestrator-btn` to use `var(--transition-fast)`.

Token hierarchy:
- `--transition-quick: 0.1s` — micro-interactions (button press, toggle)
- `--transition-fast: 0.12s` — card hover, button hover (existing value, now tokenized)
- `--transition-regular: 0.25s` — panel open/close, color scheme changes

## 2. Theme-Toggle Transition Prep

### Problem
App is dark-only. No toggle exists yet. Need to prepare CSS so that when a toggle is added, colors cross-fade smoothly instead of snapping.

### Solution
Add `.theme-transition` class to `globals.css`. When applied to `<html>`, it transitions `background-color`, `border-color`, and `color` on all descendants using `--transition-regular`. Zero-cost until a toggle sets this class.

```css
html.theme-transition,
html.theme-transition * {
  transition:
    background-color var(--transition-regular) ease,
    border-color var(--transition-regular) ease,
    color var(--transition-regular) ease !important;
}
```

## 3. Page Entrance Animations

### Problem
Hard page navigations (`<a href>`) have no visual continuity — content appears instantly.

### Solution
Use the existing `slide-up` keyframe in `globals.css`. Add a `.page-enter` utility that applies this animation. Apply `.page-enter` to the main content wrapper in `Dashboard` and `SessionDetail` page containers.

```css
.page-enter {
  animation: slide-up var(--transition-regular) ease both;
}
```

The `slide-up` keyframe (already defined):
```css
@keyframes slide-up {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

## 4. Kanban Drag-and-Drop Visual Feedback

### Problem
Kanban columns have no drag interaction. Sessions can't be dragged between columns. No placeholder/drop-target highlighting.

### Solution
- **CSS classes** in `globals.css`:
  - `.session-card--dragging`: reduced opacity + scale down (card being dragged)
  - `.kanban-col--drag-over`: accent-tinted border + subtle background glow (drop target column)
- **HTML5 drag API** wired to `SessionCard` and kanban column divs in `Dashboard`:
  - `SessionCard` gets `draggable="true"` + `onDragStart`/`onDragEnd`
  - Kanban column wrappers get `onDragEnter`/`onDragLeave`/`onDrop`
  - State: `draggingSessionId` + `dragOverLevel` tracked in `Dashboard`

Cards do **not** reorder on drop — that is a separate feature. The goal is purely visual feedback: the dragged card dims, the target column highlights.

## Files Changed

- `packages/web/src/app/globals.css` — tokens, theme-transition class, page-enter class, DnD CSS
- `packages/web/src/components/Dashboard.tsx` — drag state, column drag handlers, page-enter class
- `packages/web/src/components/SessionCard.tsx` — draggable attribute, drag start/end handlers
