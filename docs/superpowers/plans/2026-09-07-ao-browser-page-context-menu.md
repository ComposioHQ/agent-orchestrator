# AO Browser Page Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render browser-page context menus in AO's visual language without BrowserView restacking, and add an authenticated **Save link as…** action.

**Architecture:** The existing browser preload owns a closed-Shadow-DOM menu inside each browsed page. The main-process browser host computes allowed actions, retains target metadata, sends presentation payloads to the active tab, validates returned request IDs/senders, and executes privileged actions. Saving uses Electron's save dialog followed by the active tab's authenticated download session.

**Tech Stack:** Electron, TypeScript, DOM/Shadow DOM, Vitest, Vite

**Spec:** `docs/superpowers/specs/2026-09-07-browser-page-context-menu-design.md`

## Global Constraints

- Do not hide, resize, or restack the `WebContentsView` to display the menu.
- Page-provided strings must never be inserted as HTML.
- Only the active visible tab and current request may execute an action.
- Preserve right-click annotation preselection.
- **Save link as…** appears only for safe, non-empty link URLs.

---

### Task 1: Shared menu protocol and preload UI

**Files:**
- Create: `frontend/src/shared/browser-page-context-menu.ts`
- Create: `frontend/src/browser-context-menu-preload.ts`
- Create: `frontend/src/browser-context-menu-preload.test.ts`
- Modify: `frontend/forge.config.ts`
- Modify: `frontend/src/main.ts`

**Interfaces:**
- Produces: `BrowserPageContextMenuPresentation`, `BrowserPageContextMenuActionInput`, and `BrowserPageContextMenuDismissInput`.
- Produces: preload listeners for `browser:pageContextMenu:show` and `browser:pageContextMenu:hide`, with sends on `browser:pageContextMenu:action` and `browser:pageContextMenu:dismiss`.

- [ ] **Step 1: Write the failing preload tests**

Test that a presentation renders `[data-ao-browser-context-menu]` in a Shadow DOM with AO surface/item classes, literal localized labels, separators, clamped coordinates, click routing, outside-click dismissal, ArrowUp/ArrowDown navigation, Enter activation, and Escape dismissal. Assert no `data-browser-native-overlay` attribute exists.

- [ ] **Step 2: Run the preload test to verify RED**

Run: `npm --prefix frontend test -- --run src/browser-context-menu-preload.test.ts`

Expected: FAIL because the preload module and protocol do not exist.

- [ ] **Step 3: Implement the protocol and isolated menu renderer**

Define the action union as `"annotate" | "open-link-tab" | "open-link-external" | "copy-link" | "save-link" | "copy-selection" | "inspect"`. Render buttons from a main-provided ordered list, clamp after measuring, use a closed Shadow DOM in production, and remove all DOM/listeners on dismissal.

- [ ] **Step 4: Register the preload build and path**

Add `{ entry: "src/browser-context-menu-preload.ts", config: "vite.preload.config.ts", target: "preload" }` to Forge. Add a `browserContextMenuPreloadPath()` resolver beside `annotatePreloadPath()` and pass it to `createBrowserViewHost`.

- [ ] **Step 5: Run tests and typecheck to verify GREEN**

Run: `npm --prefix frontend test -- --run src/browser-context-menu-preload.test.ts && npm --prefix frontend run typecheck`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/shared/browser-page-context-menu.ts frontend/src/browser-context-menu-preload.ts frontend/src/browser-context-menu-preload.test.ts frontend/forge.config.ts frontend/src/main.ts
git commit -m "feat: render AO browser context menu in page"
```

### Task 2: Secure main-process menu routing

**Files:**
- Modify: `frontend/src/main/browser-view-host.ts`
- Modify: `frontend/src/main/browser-view-host.test.ts`

**Interfaces:**
- Consumes: shared page-menu presentation/action/dismiss types from Task 1.
- Produces: verified IPC handlers and page-menu show/hide messages.

- [ ] **Step 1: Write failing browser-host tests**

Assert that a valid link produces this exact ordered action list: Annotate, separator, Open link in new tab, Open in external browser, Copy link address, Save link as…, optional Copy, separator, Inspect Element. Assert the payload contains page-local coordinates and a request ID. Assert action and dismissal messages from the wrong sender, stale request, hidden session, or inactive tab do nothing.

- [ ] **Step 2: Run the browser-host test to verify RED**

Run: `npm --prefix frontend test -- --run src/main/browser-view-host.test.ts`

Expected: FAIL because the host still calls Electron's native `Menu.popup` presenter.

- [ ] **Step 3: Replace the native presenter with preload messaging**

Store `{ requestId, tabId, actions, pagePoint, linkURL, selectionText }`, send the ordered text-only presentation to the active tab, register action/dismiss IPC listeners, validate `event.sender.id`, request ID, tab ID, visibility, and active tab, then route existing actions. Send `browser:pageContextMenu:hide` during navigation, tab changes, hide, and destruction.

- [ ] **Step 4: Run browser-host and annotation tests to verify GREEN**

Run: `npm --prefix frontend test -- --run src/main/browser-view-host.test.ts src/annotate-preload.test.ts`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/main/browser-view-host.ts frontend/src/main/browser-view-host.test.ts
git commit -m "feat: route AO browser context menu actions"
```

### Task 3: Save link as

**Files:**
- Modify: `frontend/src/main/browser-view-host.ts`
- Modify: `frontend/src/main/browser-view-host.test.ts`
- Modify: `frontend/src/main.ts`
- Modify: `frontend/src/renderer/i18n/en.json`
- Modify: `frontend/src/renderer/i18n/de.json`
- Modify: `frontend/src/renderer/i18n/es.json`
- Modify: `frontend/src/renderer/i18n/fr.json`
- Modify: `frontend/src/renderer/i18n/ja.json`
- Modify: `frontend/src/renderer/i18n/ko.json`
- Modify: `frontend/src/renderer/i18n/pt-BR.json`
- Modify: `frontend/src/renderer/i18n/zh-CN.json`

**Interfaces:**
- Consumes: `save-link` action and retained link URL from Task 2.
- Produces: `saveLink(url, sourceWebContents): Promise<void>` main-process dependency.

- [ ] **Step 1: Write failing save-link tests**

Assert a valid link exposes **Save link as…**, canceling the dialog performs no download, accepting `/tmp/manual.pdf` calls the active tab's authenticated `downloadURL`, and the matching `will-download` item receives `setSavePath("/tmp/manual.pdf")`. Assert unsafe URLs do not expose the action.

- [ ] **Step 2: Run the save-link tests to verify RED**

Run: `npm --prefix frontend test -- --run src/main/browser-view-host.test.ts`

Expected: FAIL because `save-link` is not executed.

- [ ] **Step 3: Implement save dialog and authenticated download**

Pass a main-process `saveLink` dependency that derives a decoded URL basename, calls `dialog.showSaveDialog({ defaultPath })`, installs a scoped `will-download` listener, invokes `sourceWebContents.downloadURL(url)`, assigns `item.setSavePath(filePath)` only for the matching source and URL, and removes the listener after match or startup failure.

- [ ] **Step 4: Add localized labels**

Add `browser.contextMenu.saveLink` to every catalog, using **Save link as…** in English and natural translations in the existing supported locales.

- [ ] **Step 5: Run focused tests and typecheck to verify GREEN**

Run: `npm --prefix frontend test -- --run src/main/browser-view-host.test.ts src/browser-context-menu-preload.test.ts src/annotate-preload.test.ts && npm --prefix frontend run typecheck`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/main/browser-view-host.ts frontend/src/main/browser-view-host.test.ts frontend/src/main.ts frontend/src/renderer/i18n/*.json
git commit -m "feat: add save link as browser action"
```

### Task 4: Remove native menu path and verify dev app

**Files:**
- Modify: `frontend/src/main.ts`
- Modify: `frontend/src/main/browser-view-host.ts`
- Modify: `frontend/src/main/browser-view-host.test.ts`

**Interfaces:**
- Consumes: completed page-menu preload and action routing.
- Produces: no Electron `Menu.popup` dependency for browser-page context menus.

- [ ] **Step 1: Remove the native menu presenter and obsolete types**

Delete browser-page `Menu.buildFromTemplate(...).popup(...)` setup and its presenter interface. Keep unrelated application menu usage intact.

- [ ] **Step 2: Run fresh verification**

Run: `npm --prefix frontend run typecheck && npm --prefix frontend test -- --run src/main/browser-view-host.test.ts src/browser-context-menu-preload.test.ts src/annotate-preload.test.ts src/renderer/hooks/useBrowserView.test.tsx src/renderer/components/BrowserPanel.test.tsx && git diff --check`

Expected: all commands exit 0.

- [ ] **Step 3: Commit the cleanup**

```bash
git add frontend/src/main.ts frontend/src/main/browser-view-host.ts frontend/src/main/browser-view-host.test.ts
git commit -m "refactor: remove system browser context menu"
```

- [ ] **Step 4: Restart AO from the worktree**

Stop the existing `npm run dev` session, start `npm run dev` from `frontend/`, and confirm the main, preload, and renderer bundles build and the app connects to its browser runtime.
