# Feature plan: Touch scrolling for DirectTerminal

**Status:** Implemented in `DirectTerminal.tsx` (pointer events → `scrollLines`, alt-buffer guard, cleanup on dispose).

**Goal:** One-finger vertical drag on mobile scrolls xterm's scrollback buffer (same as mouse wheel on desktop).

---

## Validation

1. `pnpm build && pnpm typecheck && pnpm lint && pnpm test` from repo root (or `packages/web`: `tsc --noEmit`, `vitest run`, `eslint` on `src/`).
2. Manual: session detail on mobile — vertical swipe on terminal scrolls scrollback; desktop wheel unchanged.
