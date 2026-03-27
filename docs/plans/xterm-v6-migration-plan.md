# Plan: Migrate web dashboard from xterm.js 5 → `@xterm/xterm` 6

**Status:** Implemented (web uses `@xterm/xterm` 6.0.0; mobile CDN aligned; CLI fixture updated).

## Current state (post-migration)

| Area | Today |
|------|--------|
| **Package** | `@xterm/xterm` ^6.0.0 |
| **Addons** | `@xterm/addon-fit` ^0.11.0, `@xterm/addon-web-links` ^0.12.0 |
| **Primary consumer** | `packages/web/src/components/DirectTerminal.tsx` |
| **CSS** | `import "@xterm/xterm/css/xterm.css"` + overrides in `globals.css`, `workspace.css` |
| **Tests** | Unit tests only hit URL/theme helpers in `DirectTerminal`; no xterm mocks |
| **Other** | `packages/mobile` loads `@xterm/xterm@6.0.0` from jsDelivr; CLI stale-cache test uses `@xterm+xterm@6.0.0.js` as example vendor-chunk name |

**Rationale:** Scoped `@xterm/xterm` is the supported package; unscoped `xterm` 5.x is legacy.

---

## Why consider v6

- **Viewport / scrollbar** was rebuilt (VS Code base); may address width/clipping issues that v5 + custom CSS cannot fix cleanly.
- **Fit addon** and dimension behavior evolved; release notes call out scrollbar-related fixes.
- **OSC 52** support landed in core (#4220); we may be able to simplify or reconcile with our custom `registerOscHandler(52, …)` clipboard path.

---

## Breaking changes that affect this repo (from xterm.js 6.0.0 release notes)

1. **Package rename:** `xterm` → `@xterm/xterm` (import paths and CSS path change).
2. **`ITerminalOptions.overviewRulerWidth` removed** — use `overviewRuler` object (we are not using the old top-level property today).
3. **`fastScrollModifier` removed** (#5462) — **we pass `fastScrollModifier: "alt"`** in `DirectTerminal.tsx`; must delete or replace with embedder key handling if we still want Alt+scroll behavior.
4. **Viewport / scrollbar behavior changed** — our `globals.css` rules targeting `.xterm-viewport` (`overflow-y: overlay`, webkit scrollbar styling) may need to be **re-tested and possibly removed or rewritten**; DOM structure/styling may differ from v5.
5. **Alt → Ctrl+arrow hack removed** — only relevant if we relied on it (we do not appear to).
6. **`@xterm/addon-canvas` removed** — we do not use it; default DOM (or optional WebGL addon) is fine.

---

## Migration work (ordered)

### 1. Dependencies (`packages/web/package.json`)

- Remove `xterm`.
- Add `@xterm/xterm` pinned to `6.0.0` (or `^6.0.0` if you prefer range after smoke test).
- Keep `@xterm/addon-fit` and `@xterm/addon-web-links` at **latest published** (`0.11.0` / `0.12.0` today); after `npm install`, confirm no peer warnings for `@xterm/xterm`. If npm reports a mismatch, bump addons to the versions xterm 6’s release notes or addon README recommend.

### 2. `DirectTerminal.tsx` (largest change)

- Replace `import "xterm/css/xterm.css"` → `@xterm/xterm/css/xterm.css` (verify exact export path in package `exports` after install).
- Replace `import type { … } from "xterm"` → `@xterm/xterm`.
- Replace dynamic `import("xterm")` → `import("@xterm/xterm")`.
- Remove **`fastScrollModifier`** (and related options if v6 drops them—double-check types after upgrade).
- Re-run TypeScript: fix any renamed/removed `ITerminalOptions` or API types.
- **`_core` access:** still private API; v6 may move internals. If types break, keep minimal `as any` shims or replace `fitTerminal` correction with public APIs only (e.g. `FitAddon.proposeDimensions()` if exposed and sufficient).
- **OSC 52:** Read v6 docs / try without custom handler first; if core handles clipboard, remove duplicate `registerOscHandler(52)` to avoid double handling. If core does not match our tmux flow, keep custom handler and document why.

### 3. CSS

- **`globals.css`:** Revalidate all `.xterm .xterm-viewport` / scrollbar rules against v6 DOM; remove overrides that fight the new scrollbar if they cause layout bugs.
- **`workspace.css`:** `.workspace-terminal-content .xterm { overflow: hidden; max-width: 100%; }` — retest after v6; still useful for grid panes but could interact differently with new layout.

### 4. Mobile (`packages/mobile/src/terminal/terminal-html.ts`)

- Optional follow-up: bump CDN URLs from `@xterm/xterm@5.5.0` (and addon-fit) to **6.x** for parity with web. Not required for web migration but avoids behavioral drift between WebView and dashboard.

### 5. CLI / stale-build tests (`packages/cli/__tests__/commands/dashboard.test.ts`)

- The test uses a **literal** `xterm@5.3.0.js` vendor-chunk filename. After Next bundles `@xterm/xterm`, the chunk name will change—update the fixture path to match a fresh `next build` output (or generalize the test to any `vendor-chunks/*xterm*` pattern if you want less churn).

### 6. Docs / dev pages (low priority)

- `packages/web/src/app/dev/terminal-test/page.tsx` mentions “xterm.js 5.3.0”—update version string after upgrade.

### 7. Verification

- Manual: session workspace terminal (pane + fullscreen), resize panes, font slider, touch device if applicable, tmux copy (OSC 52 / XDA path).
- `packages/web`: `npm run typecheck`, `npm test`, `npm run build` (single build per your cost preference).

---

## Risk summary

| Risk | Mitigation |
|------|------------|
| New scrollbar/CSS breaks our overrides | Drop or rewrite `globals.css` xterm block incrementally; compare before/after in DevTools |
| `fitTerminal` + `_core` breaks on v6 | Prefer public fit API; reduce reliance on `_renderService.dimensions` |
| OSC 52 duplicate or behavior change | Test copy/paste from tmux; adjust handlers per v6 behavior |
| Next vendor chunk rename | Update CLI test fixture or pattern |

---

## Effort estimate

- **Small–medium:** ~0.5–1 day for dependency + `DirectTerminal` + CSS pass + build/tests, assuming no deep renderer addon work.
- **Larger** if v6 requires replacing `_core`-based `fitTerminal` logic or significant scrollbar CSS redesign.

---

## References

- [xterm.js 6.0.0 release notes](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)
- [xterm.js downloading / package docs](https://xtermjs.org/docs/guides/download/)
