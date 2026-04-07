# Feature Plan: UI Issues — Sidebar Links, File Preview Resilience, Terminal Scroll, Spawn Dialog

**Issue:** ui-issues-reconnection-n-terminal-scroll
**Branch:** `feat/ui-issues-reconnection-n-terminal-scroll`
**Status:** Pending

---

## Problem

- 4 distinct UI issues affecting mobile and desktop usability
- Cmd+click on sidebar sessions doesn't open a new tab (uses `router.push` not `<a>` links)
- After reconnection, file preview shows "Failed to fetch file content" error and doesn't recover; page refresh loses scroll position
- Terminal scrolling disables auto-follow with no clear way to resume on mobile
- Spawn session dialog doesn't show which project it's spawning into

## Research

### 1. Sidebar Session Links — `router.push` Instead of `<a href>`

- **File:** `packages/web/src/components/ProjectSidebar.tsx:620-656`
- **Trigger:** Cmd+click / middle-click on session entry in expanded sidebar
- **Risk:** LOW — straightforward HTML change
- Expanded sidebar sessions use `<div role="button">` with `onClick={() => router.push(...)}`
- Collapsed sidebar sessions use `<button>` with same `onClick` pattern (`ProjectSidebar.tsx:402-421`)
- Dashboard/Orchestrator buttons already use `<a href>` correctly (`ProjectSidebar.tsx:567-596`)
- `router.push()` intercepts all clicks — Cmd+click can't open new tab because there's no underlying `<a>` element

### 2. File Preview Error After Reconnection + Scroll State Lost on Refresh

- **File:** `packages/web/src/components/workspace/useFileContent.ts:76-87`
- **Trigger:** Network blip during mobile app-switch → fetch throws → error state set
- **Risk:** MEDIUM — blocks file viewing until manual re-navigation

**Error not recovering:**
- `fetchFileContent()` catches errors and sets `{ data: null, error: {...} }` (`useFileContent.ts:78-87`)
- This **clears `data`** — previous file content is thrown away on a transient error
- The 5s polling interval retries (`useFileContent.ts:108-110`), but next success must fully re-fetch
- Meanwhile `FilePreview.tsx:120-128` renders the error state with `UnsupportedPreview` — a dead-end UI with no retry affordance
- Root cause: transient fetch failure nukes `data` and sets sticky `error`; recovery depends on next successful poll but user sees error in the gap

**Scroll state lost on refresh:**
- Scroll position saved to `sessionStorage` via `saveSessionFileState()` (`WorkspaceLayout.tsx:230-237`)
- `sessionStorage` persists within a tab across refreshes — data survives
- Restore logic (`WorkspaceLayout.tsx:182-212`) polls until `scrollHeight > clientHeight`, then sets `scrollTop`
- But `sessionFileState.ts` only stores **one file's state per session** — key is `workspace:last-opened:${sessionId}`
- If user views file A (scroll saved), switches to file B (overwrites saved state), refreshes → file A's scroll is gone
- Fix: store scroll per-file, not just per-session

### 3. Terminal Scrolling "Pauses" Output

- **File:** `packages/web/src/components/DirectTerminal.tsx:493-503`, `566-582`
- **Trigger:** User scrolls up in terminal (desktop or mobile)
- **Risk:** MEDIUM — confusing UX, appears broken
- Scrolling away from bottom sets `followOutput = false` (`DirectTerminal.tsx:500`)
- New data still writes to xterm but auto-scroll disabled (`DirectTerminal.tsx:579`)
- "Jump to latest ↓" button appears (`DirectTerminal.tsx:914-928`) but on mobile it's easy to miss — small, bottom-right
- On mobile touch scroll, `terminal.scrollLines()` triggers viewport scroll → disables follow
- User perception: terminal "freezes" — must tap input or find the small button to resume

### 4. Spawn Session Dialog Missing Project Name

- **File:** `packages/web/src/components/SpawnSessionModal.tsx:155-157`
- **Trigger:** Opening spawn dialog from sidebar
- **Risk:** LOW — cosmetic improvement
- Title is static: `<h2>Spawn session</h2>`
- `projectId` is the hash/ID, not display name
- `ProjectInfo` has `id` and `name` fields (`project-name.ts:4-7`)
- Project name available in `ProjectSidebar.tsx` via `project.name`

## Root Cause

- **Issue 1:** `<div role="button">` with `router.push` — no `<a>` element means no native link behavior
- **Issue 2a:** `useFileContent` clears `data` on fetch error — transient failures nuke content
- **Issue 2b:** `sessionFileState` stores only one file's scroll per session — switching files overwrites it
- **Issue 3:** No auto-resume for `followOutput` after scroll idle; "Jump to latest" button too small on mobile
- **Issue 4:** Modal title is static, doesn't include project name

## Approach

### Fix 1: Use `<a>` Elements for Sidebar Sessions

- Replace `<div role="button">` and `<button>` with `<a href={...}>` for session links
- `href`: `/sessions/${encodeURIComponent(session.id)}?project=${encodeURIComponent(project.id)}`
- `onClick`: only `e.preventDefault(); router.push(...)` for plain left-click (no modifier keys)
- Let Cmd+click / Ctrl+click / middle-click fall through to native `<a>` behavior → opens new tab
- Apply to both expanded (`ProjectSidebar.tsx:620`) and collapsed (`ProjectSidebar.tsx:402`) views

### Fix 2a: Keep Previous File Content on Transient Errors

- In `useFileContent.ts` catch block: **preserve `data`** when error is transient (`fetch_error`)
  - Change: `setState(prev => ({ data: prev.data, error: {...}, loading: false }))`
  - If `prev.data` exists, keep it — user sees stale content instead of error screen
  - If `prev.data` is null (first load failed), show error as before
- The 5s poll will recover on next success → `data` updates, `error` clears
- No UI change needed in `FilePreview.tsx` — it prioritizes `loading` → `error` → `data`, but with `data` preserved, user sees content until recovery

### Fix 2b: Store Scroll Position Per-File Per-Session

- Change `sessionFileState.ts` storage from single entry to a map: `Record<filePath, { scrollTop, updatedAt }>`
- Storage key stays `workspace:last-opened:${sessionId}` but value becomes `{ currentFile, files: { [path]: { scrollTop, updatedAt } } }`
- `saveSessionFileState()`: upsert entry for the specific file path
- `loadSessionFileState()`: return the current file + its scroll position
- Cap stored entries (e.g., 20 most recent) to avoid unbounded sessionStorage growth
- Update `WorkspaceLayout.tsx` restore logic to look up scroll for the specific file

### Fix 3: Auto-Resume Terminal Follow Near Bottom + Better Jump Button

- Add scroll-idle timer in `DirectTerminal.tsx`:
  - When `followOutput` is false AND viewport is near bottom (within ~2 screen heights), start a 2-3s idle timer
  - On timer expiry: set `followOutput = true`
  - On any new scroll event: reset the timer
  - If user is scrolled far up (more than ~2 screen heights from bottom): do NOT auto-resume — they're intentionally reading history
- Always show the "Jump to latest ↓" button on the right side when `followOutput` is false
  - Current button: `bottom-2 right-2`, small `px-3 py-2 text-[12px]`
  - Make it a floating pill/circle on the right edge, larger touch target for mobile

### Fix 4: Show Project Name in Spawn Dialog Title

- Add `projectName` prop to `SpawnSessionModal` interface
- Pass `project.name` from `ProjectSidebar.tsx` when creating modal (need to look up from projects array using `spawnModalProjectId`)
- Title: `Spawn session in` **`{projectName}`** — project name highlighted with accent color

## Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/components/ProjectSidebar.tsx` | Convert session `div/button` to `<a>` elements; pass `projectName` to spawn modal |
| `packages/web/src/components/workspace/useFileContent.ts` | Preserve previous `data` on transient fetch errors |
| `packages/web/src/components/workspace/sessionFileState.ts` | Store scroll per-file-per-session instead of single entry |
| `packages/web/src/components/workspace/WorkspaceLayout.tsx` | Update save/restore to use per-file scroll state |
| `packages/web/src/components/DirectTerminal.tsx` | Add scroll-idle auto-resume + improve jump button |
| `packages/web/src/components/SpawnSessionModal.tsx` | Add `projectName` prop, update title |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Should sidebar `<a>` links use Next.js `<Link>`?** | No — custom `<a>` with `onClick` is cleaner for modifier-key passthrough |
| 2 | **Will keeping stale data on error confuse users?** | No — the 5s poll recovers quickly. Stale content is better than error screen. Could add a subtle "connection lost" indicator later. |
| 3 | **Will auto-resume near-bottom conflict with intentional scrollback?** | Only triggers within ~2 screen heights of bottom + 2-3s idle — far-up scroll is not affected |
| 4 | **sessionStorage size limit for per-file scroll map?** | Cap at 20 files per session. sessionStorage limit is ~5MB, a scroll map is tiny. |

## Validation

- Manual test: Cmd+click / middle-click session in sidebar → opens new browser tab
- Manual test: Disconnect network briefly → file preview keeps showing content, recovers on reconnect
- Manual test: View file A (scroll down), switch to file B (scroll down), refresh → both scroll positions restored
- Manual test: Scroll up in terminal near bottom, wait 2-3s → auto-resumes following
- Manual test: Scroll far up in terminal → does NOT auto-resume, jump button visible on right
- Manual test: Tap jump button on mobile → scrolls to bottom + resumes following
- Manual test: Open spawn dialog → title shows "Spawn session in {project-name}"
- Regression: Left-click on session still navigates in same tab via SPA routing
- Regression: Terminal scrollback still works (can scroll up without snapping back immediately)
- Regression: File switching in file tree still works correctly

## Checklist

### Phase 1 — Sidebar Links (Issue 1)

- [ ] **1.1** Replace `<div role="button">` with `<a>` in expanded sidebar sessions (`ProjectSidebar.tsx:620`)
- [ ] **1.2** Replace `<button>` with `<a>` in collapsed sidebar sessions (`ProjectSidebar.tsx:402`)
- [ ] **1.3** Add smart click handler: `e.preventDefault(); router.push()` for plain left-clicks only

### Phase 2 — File Preview Resilience (Issue 2)

- [ ] **2.1** In `useFileContent.ts` catch block, preserve `prev.data` on transient errors
- [ ] **2.2** Refactor `sessionFileState.ts` to store per-file scroll map with cap (20 files)
- [ ] **2.3** Update `saveSessionFileState()` to upsert by file path
- [ ] **2.4** Update `loadSessionFileState()` to return scroll for specific file
- [ ] **2.5** Update `WorkspaceLayout.tsx` save handler to pass file path
- [ ] **2.6** Update `WorkspaceLayout.tsx` restore logic to look up per-file scroll

### Phase 3 — Terminal Scroll Resume (Issue 3)

- [ ] **3.1** Add scroll-idle timer: auto-resume `followOutput` after 2-3s when near bottom
- [ ] **3.2** Reset timer on new scroll events
- [ ] **3.3** Only auto-resume when within ~2 screen heights of bottom
- [ ] **3.4** Restyle "Jump to latest" button — right-edge floating pill, larger touch target

### Phase 4 — Spawn Dialog Project Name (Issue 4)

- [ ] **4.1** Add `projectName` prop to `SpawnSessionModal` interface
- [ ] **4.2** Look up project name from projects array in `ProjectSidebar.tsx`, pass to modal
- [ ] **4.3** Update title to "Spawn session in **{projectName}**" with accent-colored project name

### Phase 5 — Testing & Verification

- [ ] **5.1** Build (`pnpm build`) and typecheck (`pnpm typecheck`)
- [ ] **5.2** Lint (`pnpm lint`)
- [ ] **5.3** Run tests (`pnpm test`)
- [ ] **5.4** Manual testing of all 4 fixes
