# Stack Research

**Domain:** Brownfield Next.js operator dashboard with a pixel-art 2D mode
**Researched:** 2026-03-14
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Next.js App Router | `next@^15.1.0` | Existing web app shell, routing, SSR for initial dashboard payloads | Already used in `packages/web/package.json` and `packages/web/src/app/page.tsx`. Keep the pixel dashboard as another client-rendered surface inside the current app, not a separate frontend. |
| React | `react@^19.0.0` / `react-dom@^19.0.0` | UI composition and client state boundaries | Already aligned with the repo and with `pixel-agents` webview (`webview-ui/package.json`). Keep React as the orchestration layer around the canvas, not the renderer of every sprite. |
| TypeScript | `typescript@^5.7.0` in app, compatible with `~5.9.x` patterns from `pixel-agents` | Shared typed contracts between server data, SSE updates, and pixel scene state | The current app already has strong typed models in `packages/web/src/lib/types.ts`. Preserve this and add a typed scene-mapping layer rather than introducing untyped game objects. |
| Tailwind CSS | `tailwindcss@^4.0.0` | Chrome around the pixel scene: switcher, overlays, drawers, HUD | Already installed and used via `packages/web/src/app/globals.css`. Keep Tailwind for layout and panel chrome, but do not use it to render the 2D world itself. |
| Canvas 2D API | Browser-native | Pixel world rendering, camera pan/zoom, sprites, overlays | This is the right carry-over from `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx` and `.../engine/gameLoop.ts`. It avoids React DOM overhead and avoids introducing a game engine into a brownfield operational dashboard. |
| Existing session APIs + SSE | Current `/api/sessions` and `/api/events` contracts | Shared live data layer for both dashboard modes | The current seam already exists in `packages/web/src/app/api/sessions/route.ts`, `packages/web/src/app/api/events/route.ts`, and `packages/web/src/hooks/useSessionEvents.ts`. Reuse it exactly so both dashboards stay behaviorally aligned. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `clsx` | `^2.x` | Small helper for shared view-switcher and HUD class composition | Add only if the new dashboard chrome starts duplicating conditional Tailwind strings across legacy and pixel components. |
| `pixelmatch` | `^7.x` | Visual regression diffing for canvas screenshots | Add as a dev dependency only if Playwright screenshot tests become noisy and you need stable pixel-diff assertions for `packages/web/e2e`. |
| None for scene state | n/a | Avoid unnecessary state libraries | Do not add Zustand, Redux, Jotai, or XState for v1. The current React state plus a focused imperative scene model is enough. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Vitest | Unit tests for scene mapping, attention-to-sprite rules, and camera math | Already present in `packages/web/package.json`. Add tests beside new pixel modules, not in a separate test framework. |
| Playwright | End-to-end and screenshot validation for the view switcher and pixel dashboard | Already present. Prefer browser screenshots over trying to unit test rendered pixels exhaustively. |
| ESLint + Prettier | Keep code style aligned with the monorepo | Remain on the current repo tooling. Do not add a second formatter or per-package lint stack. |

## Installation

```bash
# Core
# No core stack change required. Keep the existing pnpm workspace stack.

# Supporting
pnpm --filter @composio/ao-web add clsx

# Dev dependencies
pnpm --filter @composio/ao-web add -D pixelmatch
```

If the first implementation keeps class composition simple and screenshot testing stable, add neither package.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Native Canvas 2D scene inside `packages/web` | Phaser | Use Phaser only if the roadmap later expands into full game-engine needs such as physics, asset atlases, scene loading, and plugin ecosystems. That is not justified for dashboard mode parity work. |
| Native Canvas 2D scene inside `packages/web` | PixiJS / `@pixi/react` | Use only if sprite count, effects, or GPU compositing become a measured bottleneck. For the expected operator-dashboard scale, this adds complexity without clear payoff. |
| Reuse current `/api/sessions` + `/api/events` | Dedicated WebSocket/game-state backend | Use only if the product later needs bidirectional high-frequency multiplayer-style world sync. Current SSE and action routes already match the dashboard contract. |
| Port selected ideas from `pixel-agents/webview-ui/src/office/*` | Direct dependency on the `pixel-agents` repo | Use a direct dependency only after `pixel-agents` has a host-agnostic package boundary. Today it is shaped around VS Code webview integration and asset assumptions. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Phaser for v1 | Too much framework weight for a brownfield dashboard; duplicates routing, asset, and input abstractions the app does not need | Native Canvas 2D with a small local engine module in `packages/web/src/components/pixel/engine/*` |
| PixiJS, `@pixi/react`, `react-konva` for v1 | Introduces another rendering abstraction and React integration surface before you have evidence Canvas 2D is insufficient | Follow the `pixel-agents` pattern from `webview-ui/src/office/components/OfficeCanvas.tsx` and keep rendering imperative |
| Zustand/Redux/Jotai/XState | Splits truth between React app state and the existing SSE/session model; likely over-architected for one additional dashboard mode | Keep server data in the current React flow and maintain a local scene adapter derived from `DashboardSession[]` |
| A second frontend app or standalone Vite package | Would fork routing, auth/environment assumptions, and test setup from `packages/web` | Build the pixel mode inside `packages/web` and share APIs, filters, and actions |
| Direct reuse of paid `pixel-agents` office assets | `pixel-agents/README.md` states the full office tileset is not included and depends on separately licensed assets | Start with freely owned assets committed under `packages/web/public/pixel/` and keep the renderer asset-agnostic |
| Rebuilding transport around WebSockets | The app already has SSE and REST actions wired and tested | Keep `/api/events` for live updates and current POST action routes for operator commands |

## Stack Patterns by Variant

**If the goal is milestone-1 parity:**
- Use a client-only pixel dashboard component under `packages/web/src/components/pixel/PixelDashboard.tsx`.
- Keep the existing page loader in `packages/web/src/app/page.tsx` and pass the same `DashboardSession[]` into either the legacy or pixel renderer.
- Add a scene adapter such as `packages/web/src/components/pixel/mappers/sessionScene.ts` that converts `DashboardSession`, attention level, PR state, and project filters into character/desk/world data.
- Port only the engine ideas from `pixel-agents/webview-ui/src/office/engine/gameLoop.ts`, `.../renderer.ts`, and `.../officeState.ts`; do not port VS Code messaging or extension lifecycle code.

**If the goal later expands into editable office layouts:**
- Add a separate layout model module, e.g. `packages/web/src/components/pixel/layout/*`, modeled after `pixel-agents/webview-ui/src/office/layout/*`.
- Persist layouts through the existing app backend or project config, not browser-only local state.
- Gate layout editing behind a second phase; do not let editor complexity block the first operator dashboard release.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `next@^15.1.0` | `react@^19.0.0` | This is the current app pairing in `packages/web/package.json`; keep it unchanged. |
| `react@^19.0.0` | imperative Canvas 2D loop | Safe as long as the game loop is started and cleaned up in effects and no render-time browser globals are accessed. |
| Tailwind 4 | Next 15 app router | Already configured via `packages/web/postcss.config.mjs` and `packages/web/src/app/globals.css`; use it only for UI chrome around the scene. |
| Existing SSE hook | Pixel dashboard mode | `packages/web/src/hooks/useSessionEvents.ts` should remain the single live-update source; derive scene state from it rather than opening another stream. |

## Brownfield Compatibility Notes

- Keep the server/client split exactly as it is now: load initial dashboard data on the server in `packages/web/src/app/page.tsx`, then hand off to a client component for live updates and canvas rendering.
- Treat the pixel dashboard as a client island. Use `"use client"` at the pixel dashboard entrypoint and keep canvas setup inside `useEffect`.
- Expect React 19 development behavior to mount effects more than once. The local game loop and `ResizeObserver` cleanup must be idempotent.
- Do not render sprites through JSX lists. React should own controls, filters, modals, and detail panes; the canvas should own world rendering.
- Keep image smoothing disabled and scaling integer-based, following the pattern in `pixel-agents/webview-ui/src/office/engine/gameLoop.ts` and `.../components/OfficeCanvas.tsx`.
- Do not import `pixel-agents` source files directly into the workspace package graph. Copy the relevant patterns into `agent-orchestrator` modules so the web app is not coupled to VS Code-extension internals.

## Sources

- `agent-orchestrator/packages/web/package.json` — verified current web stack: Next 15, React 19, Tailwind 4, Vitest, Playwright
- `agent-orchestrator/packages/web/src/app/page.tsx` — verified server-loaded dashboard data flow
- `agent-orchestrator/packages/web/src/hooks/useSessionEvents.ts` — verified existing SSE update strategy
- `agent-orchestrator/packages/web/src/lib/types.ts` — verified typed dashboard contract to preserve
- `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx` — verified imperative canvas integration pattern
- `pixel-agents/webview-ui/src/office/engine/gameLoop.ts` — verified lightweight render loop approach
- `pixel-agents/webview-ui/src/office/engine/officeState.ts` — verified local scene-state pattern to adapt, not directly depend on
- `pixel-agents/README.md` — verified Canvas 2D choice and asset licensing constraints

---
*Stack research for: agent-orchestrator pixel dashboard mode*
*Researched: 2026-03-14*
