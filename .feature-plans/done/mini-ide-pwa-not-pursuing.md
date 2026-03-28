# Feature plan: Mini IDE as installable PWA

**Tracker:** GitHub issue `mini-ide-pwa` (confirm numeric id for `Closes #…` in PR)  
**Branch:** `feat/mini-ide-pwa` (already checked out in this worktree)  
**Status:** **Not pursuing** — superseded by product decision (2026-03-27). Kept for history only.

---

## Problem summary

The ao web dashboard (the browser-based “mini IDE”: sessions, detail views, embedded terminals) does not advertise itself as an installable Progressive Web App. Browsers therefore do not offer “Install app” / “Add to Home Screen” in the same way as apps like code-server, and users cannot easily run it in a standalone window without the browser’s normal chrome (tabs, address bar).

Goal: meet browser installability criteria so Chrome/Edge (desktop and Android) and compatible mobile browsers can install the app and launch it in `standalone` (or equivalent) display mode.

---

## Research findings

### Where the UI lives

- **`packages/web`** — Next.js 15 App Router (`next@^15.1.0`), React 19, `src/app/` layout and pages.
- **`src/app/layout.tsx`** — Root layout; `generateMetadata()` sets title template and description; no PWA manifest or install-related metadata yet.
- **`src/app/icon.tsx`** — Dynamic 32×32 favicon via `ImageResponse`; **not** sufficient for PWA (install flow expects **192×192** and **512×512** icons, typically PNG).
- **`next.config.js`** — Minimal; no PWA or service-worker integration.
- **No** `manifest.json` / `app/manifest.ts` / service worker in the repo today.

### Runtime interactions (service worker risk)

- **`Terminal.tsx`** — Fetches ttyd URL from **`hostname:terminalPort`** (default `NEXT_PUBLIC_TERMINAL_PORT` / `14800`). Different **origin** (port) from the Next app, so the app’s scoped service worker should not control those requests.
- **`DirectTerminal.tsx`** — WebSocket-based terminal; if the WS URL is **same origin** as the page, a poorly configured SW could theoretically interfere. Any PWA tooling must **not** cache or intercept WebSocket upgrades or `/api/*` (and should follow Workbox “network first” or bypass for API routes).

### Related packages

- **`packages/mobile`** — Expo/React Native shell; **out of scope** for this issue unless product asks for a separate native wrapper. This plan targets the **web** dashboard PWA only.

### Next.js–native pieces

- Next.js supports a typed **`app/manifest.ts`** (or `.js`) convention that emits `manifest.webmanifest` and links it automatically — good fit for `name`, `short_name`, `start_url`, `display`, `theme_color`, `icons`.
- **Installability** on Chromium still requires a **registered service worker** that handles **`fetch`** (not manifest alone). That implies either:
  - a maintained integration such as **`@ducanh2912/next-pwa`** (Workbox-based, common for App Router), or
  - a **minimal custom** `public/sw.js` plus a small client-only registration (more control, more maintenance).

---

## Proposed approach

1. **Web App Manifest**
   - Add **`src/app/manifest.ts`** exporting a manifest compatible with `MetadataRoute.Manifest` from Next.js.
   - Set **`display: "standalone"`** (or `"standalone"` + `display_override` if needed later).
   - Set **`start_url`:** `/` (and **`scope`:** `/`). If product wants a default project deep-link, that can be a follow-up; `?project=` on the home page is dynamic and may not belong in `start_url` without a stable default.
   - **`name` / `short_name`:** derive from existing **`getProjectName()`** where possible so multi-project deployments still feel branded; fallback `"ao"`.
   - **`theme_color` / `background_color`:** align with `globals.css` / dark theme tokens (avoid jarring install splash).

2. **Icons (required for install prompts)**
   - Provide **192×192** and **512×512** PNGs (and optional maskable variant for Android).
   - Options:
     - **Static assets** under `public/` (e.g. `public/icons/...`) referenced from the manifest, **or**
     - Additional **file-based metadata routes** if we want generated icons consistent with `icon.tsx` (more work; static PNGs are faster to ship).
   - Add **`apple-touch-icon`** via `app/apple-icon.tsx` or link in metadata for iOS “Add to Home Screen” polish.

3. **Service worker**
   - Prefer **`@ducanh2912/next-pwa`** wired in **`next.config.js`** with conservative caching:
     - Ensure **API routes** and **dynamic** session pages are not cached incorrectly (plugin usually excludes `/_next/static` issues; verify **`app/page.tsx`** is `force-dynamic` — it already is).
     - Explicitly **exclude** patterns that could break **WebSockets** or **SSE** if used (`/api/events` etc.).
   - Alternative if we want zero new dependency: **hand-written** minimal SW that only satisfies installability (e.g. `fetch` passthrough + empty cache) — smallest surface, but easy to get wrong across Next upgrades.

4. **Registration**
   - If using the plugin, it injects registration; otherwise a tiny **client component** mounted once from `layout.tsx` that calls `navigator.serviceWorker.register('/sw.js')` in production only.

5. **Optional UX**
   - Document in README or in-app help that install requires **HTTPS** (or `localhost`) — same as any PWA.
   - Optional later: small “Install ao” hint using `beforeinstallprompt` (Chrome); not required for the browser’s default install entry in the menu.

---

## Files to modify (expected)

| Area | Files |
|------|--------|
| Manifest | `packages/web/src/app/manifest.ts` (new) |
| Icons | `packages/web/public/icons/*.png` (new) and/or `apple-icon` route |
| Metadata | `packages/web/src/app/layout.tsx` — supplementary `metadata` (e.g. `appleWebApp`, `applicationName`) if not fully covered by manifest |
| Build | `packages/web/next.config.js` — PWA wrapper if using `@ducanh2912/next-pwa` |
| Deps | `packages/web/package.json` — add PWA dependency if chosen |
| Types/tests | Adjust or add a **lightweight** test or build-time assertion only if the repo pattern supports it (e.g. manifest JSON snapshot); avoid heavy E2E unless already standard |

---

## Risks and open questions

| Risk / question | Mitigation |
|-----------------|------------|
| SW breaks terminal or live updates | Test DirectTerminal + session list after install; configure Workbox `exclude` / runtimeCaching carefully; prefer network-first for `/api/*`. |
| Stale shell after deploy | Use plugin defaults for `skipWaiting` / `clientsClaim` with eyes open; document hard refresh if needed. |
| **`start_url` vs `?project=`** | Starting at `/` is safest; per-project install is a product decision. |
| **iOS** | Full “install” UX varies; manifest + apple-touch-icon improves but may not match Android/Chrome parity. |
| **Issue number** | Confirm GitHub **#id** for `Closes #…` in PR and commit footer. |

---

## Validation strategy

1. **`pnpm build && pnpm typecheck && pnpm lint && pnpm test`** from monorepo root (per project rules).
2. **Manual:** `pnpm --filter @composio/ao-web dev` (or production `next start` after build), open in Chrome:
   - DevTools → **Application** → Manifest: no errors; icons present.
   - **Lighthouse** PWA category (or Chrome’s installability check).
   - Install app; confirm **standalone** window and that **dashboard**, **API-driven session list**, and **DirectTerminal** still work.
3. **Regression:** Hit **`/api/*`** and session detail routes; confirm no offline-first stale data for dynamic orchestration views unless explicitly desired later.

---

## Implementation checklist (when approved)

- [ ] Add manifest + icons + theme colors
- [ ] Add service worker (plugin or minimal custom) with safe caching boundaries
- [ ] Verify install prompt on Chrome desktop + Android; sanity-check Safari “Add to Home Screen”
- [ ] Commit with conventional message, **body/footer linking issue** (e.g. `Closes #NNN` or `Refs #NNN`)
- [ ] Run full pre-push pipeline; open PR with clear description
