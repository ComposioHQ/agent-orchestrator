# Feature Plan: Show killed sessions, session detail restore, consistent sidebar labels

**Issue:** fix-killed-session-toggle  
**Branch:** `feat/fix-killed-session-toggle`  
**Status:** Pending  
**Default branch / PR base:** `gb-personal`

---

## Problem summary

1. **Killed sessions are easy to miss in the UI**  
   Workers can end up with `status === "killed"` (explicit kill, dead runtime, agent exited, PR closed unmerged, etc.). Users want to **optionally surface only those** — not every “done” outcome (e.g. **merged** PRs).

2. **Today’s “Show done” is the wrong abstraction**  
   `useShowDone` / `ao-show-done` gates **`getAttentionLevel(session) === "done"`**, which bundles **merged**, **killed**, **terminated**, **cleanup**, **done**, **closed PRs**, etc. The product ask is **narrower**: a **“Show killed sessions”** toggle that **additionally** lists rows where **`session.status === "killed"`** (default: hidden).

3. **Sidebar never receives many dead workers**  
   `(with-sidebar)/layout.tsx` uses `GET /api/sessions?active=true`, which **drops workers with `activity === exited`** (`api/sessions/route.ts`). Killed sessions are often exited first, so they **never reach the client** — no toggle can fix that until the fetch includes them.

4. **All Projects overview**  
   `projectOverviews` should treat **killed** like the sidebar: **exclude** `status === "killed"` from counts / lists when the toggle is off; **include** when on (optional **Killed** metric when on).

5. **Single-project Kanban**  
   Replace the old **Hide/Show done** control with **Hide/Show killed**. Keep a **Done** column for **non-killed** sessions that still map to attention **done** (merged, terminated, cleanup, etc.). When the toggle is on, add a **Killed** column listing only `status === "killed"`.

6. **Session detail lacks restore**  
   `SessionCard` (done variant) already exposes **restore** via `onRestore` → `POST /api/sessions/:id/restore`. **`SessionDetail.tsx` has no restore control** — users opening `/sessions/:id` for a killed session need a visible **Restore session** action (same API, same non-restorable rules as cards — **never** for `merged`; align with `SessionCard`’s `isRestorable` logic using `TERMINAL_STATUSES` / `TERMINAL_ACTIVITIES` and `NON_RESTORABLE_STATUSES` from `@/lib/types`).

7. **Sidebar UX (unchanged scope from prior plan)**  
   - **All Projects** row: `cursor-pointer`.  
   - **Project row:** click = expand/collapse only; **two `<a href>`** links on the right (project dashboard + orchestrator), native new-tab behavior.  
   - **Collapsed rail:** per-project **New session** affordance + single **`SpawnSessionModal`**.  
   - Pass **`orchestrators`** from layout into `ProjectSidebar`.

8. **Inconsistent sidebar session labels**  
   Rows use **`getSessionTitle()`** (`packages/web/src/lib/format.ts`), which falls through to **`session.summary`** even when that text is a **low-signal agent transcript** (e.g. “You are an AI…”, “Session end”). Summaries and **`issueTitle`** also arrive **asynchronously** after `/api/sessions` refresh, so **one row can change wording** while another session is selected — feels random.  
   **Desired:** Stable, human-meaningful labels: prefer **tracker issue title** for real numbered issues, **issue label / slug** for non-numeric spawn topics, and optionally **branch** as a second line for disambiguation.

---

## Definitions

| Term | Meaning |
|------|---------|
| **Killed session (product)** | `DashboardSession` worker with **`session.status === "killed"`** (strict — not `terminated`, not `merged`, not merely `activity === "exited"` with another status). |
| **Show killed (toggle on)** | Include those rows in sidebar, All Projects aggregates, and Kanban **Killed** column. |
| **Toggle off (default)** | Omit `status === "killed"` from those surfaces. |

**Note:** A session can be **dead in the terminal** but still **`working`** until lifecycle promotes it to **`killed`** — those will not appear in the **Killed** bucket until status updates. Out of scope unless we add a separate “exited but not killed” rule later.

---

## Research findings

| Area | Finding |
|------|---------|
| **Old preference** | `packages/web/src/hooks/useShowDone.ts` — `ao-show-done`; **replace** with a killed-specific hook + storage key (see below). |
| **Consumers** | `Dashboard.tsx`, `ProjectSidebar.tsx` import `useShowDone`. |
| **Sidebar fetch** | `layout.tsx`: `fetch("/api/sessions?active=true")` strips exited workers. |
| **Restore API** | `Dashboard.tsx` `handleRestore` → `POST /api/sessions/${id}/restore` with `confirm()`. |
| **Card restorability** | `SessionCard.tsx`: `isRestorable = isTerminal && session.status !== "merged"`. |
| **Orchestrators in layout** | `GET /api/sessions` returns `orchestrators`; layout currently ignores it. |
| **Sidebar title** | `ProjectSidebar` uses **`getSessionTitle()`**; fallback chain includes **any** `summary` (step 4), which surfaces noise; **PR title** can also dominate and differ from issue-centric mental model. |

---

## Proposed approach

### A. Preference hook: `useShowKilledSessions`

- **New file** `packages/web/src/hooks/useShowKilledSessions.ts` (or rename/replace `useShowDone.ts` — **delete** old hook after migrating).  
- **Storage key:** `ao-show-killed-sessions` (string `"true"` / absent = off).  
- **Cross-tab sync:** mirror `useShowDone` pattern (`storage` event + custom event e.g. `ao-show-killed-sessions-changed`).  
- **Optional one-time migration:** if `ao-show-done === "true"`, seed `ao-show-killed-sessions` — **optional**; document as implementer choice.

### B. Helper

- **`isKilledSession(session: DashboardSession): boolean`** — `session.status === "killed"` (and exclude orchestrator rows if they ever appear in the same list — sidebar already uses worker lists).

### C. `GET /api/sessions` for sidebar

- **`layout.tsx`:** fetch **`/api/sessions`** without `active=true`; parse **`orchestrators`**, pass to **`ProjectSidebar`**.

### D. Sidebar + All Projects + Kanban

- **Sidebar:** `workerSessions.filter((s) => showKilled || !isKilledSession(s))`. Toggle label **“Show killed sessions”** / **“Hide killed sessions”** (expanded sidebar only for toggle, per earlier UX choice).  
- **`ProjectSidebar`:** `const [showKilled, setShowKilled] = useShowKilledSessions()`.  
- **`Dashboard.tsx`:**  
  - Replace `useShowDone` with `useShowKilledSessions`.  
  - **`projectOverviews`:** when computing per-project sessions / counts, exclude killed if `!showKilled`; when `showKilled`, optionally add a **Killed** `ProjectMetric`.  
  - **Kanban:**  
    - Build **`grouped`** from **`displaySessions.filter(s => showKilled || !isKilledSession(s))`** **or** partition: non-killed → existing `getAttentionLevel` buckets; killed → separate array.  
    - **Done column:** only sessions with `getAttentionLevel === "done"` **and** `!isKilledSession` (so merged etc. stay here; killed do not duplicate).  
    - **`kanbanLevels`:** `["working", "pending", "review", "respond", "merge", "done"]` **plus** `"killed"` **iff** `showKilled`.  
  - **Toggle placement:** single-project board header **and** **All Projects** view (when `allProjectsView`), even when `hasAnySessions` is false if needed so users can pre-enable before data loads.  
  - **Labels:** **“Show killed sessions”** / **“Hide killed sessions”**.

### E. Types + `AttentionZone`

- Extend **`AttentionLevel`** in `packages/web/src/lib/types.ts` with **`"killed"`** (document: **display / Kanban only** — `getAttentionLevel` never returns `"killed"`).  
- Update **`AttentionZone.tsx`** `zoneConfig` and props to support **`killed`** (label e.g. **Killed**, caption e.g. **Stopped or dead — restore to resume**).  
- **`hasAnySessions`:** include killed column sessions when deciding whether the board has content (so a fleet of only killed sessions still shows the board when toggle is on).

### F. `SessionDetail.tsx`

- If **`isKilledSession(session)`** (or broader **restorable terminal** matching `SessionCard`): show a **prominent strip** (e.g. below `SessionTopStrip`): **“This session is killed.”** + **`Restore session`** button.  
- **Handler:** same as dashboard — `POST /api/sessions/:id/restore`, **`confirm()`** optional (prefer **one** clear confirm before restore to match dashboard).  
- On success: **router.refresh()** or refetch session detail so UI updates.  
- **Hide / disable** restore when **`NON_RESTORABLE_STATUSES.has(session.status)`** (e.g. merged), same rules as cards.

### G. Sidebar UX (project rows, spawn, links)

- Same as previous plan: **All Projects** `cursor-pointer`; project header **expand-only**; **`<a>`** links for dashboard + orchestrator with `stopPropagation`; **collapsed** spawn **`+`**; **one** `SpawnSessionModal` at `ProjectSidebarInner` root.

### H. Ctrl+click / new tab

- Use real **`<a href>`** for dashboard + orchestrator shortcuts.

### I. Consistent sidebar (and collapsed rail) session labels

**Recommendation (product + engineering):**

- Introduce **`getSessionSidebarLabel(session): string`** (or **`getSessionListPrimaryLabel`**) in **`packages/web/src/lib/format.ts`**, used **only** for **sidebar expanded rows** and as the **source string for collapsed 3-letter abbreviations** — keep **`getSessionTitle()`** for Kanban cards / session detail headline unless you decide to align those later.

- **Primary line — strict order (no generic summary):**  
  1. **`issueTitle`** when set — this is the GitHub (tracker) title fetched by **`enrichSessionIssueTitle()`** for URL-backed issues, including **numeric** `#42`-style ids once enrichment completes.  
  2. Else **`issueLabel`** when it looks like a **non-numeric topic** (e.g. spawn string, Jira-style `PROJ-123`, slug) — heuristic: **not** matching **`/^#?\d+$/`** after trim (tune if needed for your trackers).  
  3. Else **`issueLabel`** when numeric-only (e.g. `#7`) and **`issueTitle`** still null — show label as **stable placeholder** until title loads (avoid swapping to summary).  
  4. Else **`humanizeBranch(session.branch)`** if branch present.  
  5. Else truncated **`session.id`**.  
  - **Do not** use **`session.summary`** for this primary label (it causes “You are an AI…”, “Session end”, etc.). Optionally allow **`summary`** only when **`!summaryIsFallback`** *and* you add a **short length cap** — default **off** for sidebar.

- **Secondary line (recommended):** Under the primary label, render **`session.branch`** in **muted `font-mono` ~10px** when branch is non-null — disambiguates multiple sessions on similar topics without depending on noisy summaries. Collapsed rail may stay **single-line** (abbrev only) to save space.

- **Stability:** Label changes only when **`issueTitle` / `issueLabel` / `branch` / `id`** from the server change — not when a new summary line appears in agent logs.

**Optional later:** Use the same primary helper for **Session detail** crumb / title for full consistency across chrome.

---

## Files to modify

| File | Change |
|------|--------|
| `packages/web/src/hooks/useShowKilledSessions.ts` | **New** hook (replace `useShowDone.ts` usage; remove old file when migrated). |
| `packages/web/src/lib/types.ts` | Add `"killed"` to `AttentionLevel`; export **`isKilledSession`** (or separate `session-filters.ts` if you prefer thin types file). |
| `packages/web/src/app/(with-sidebar)/layout.tsx` | `/api/sessions` without `active=true`; pass **`orchestrators`** to sidebar. |
| `packages/web/src/components/ProjectSidebar.tsx` | `useShowKilledSessions`; filter killed; toggle UI; orchestrator links; collapsed spawn; header behavior; **`getSessionSidebarLabel`** + optional **branch** subtitle (expanded rows + collapsed abbr source). |
| `packages/web/src/lib/format.ts` | **`getSessionSidebarLabel`** (+ small **`isNumericIssueLabel`?** helper); unit tests. |
| `packages/web/src/lib/__tests__/format.test.ts` | Tests for sidebar label ordering and numeric vs slug **issueLabel**. |
| `packages/web/src/components/Dashboard.tsx` | Killed toggle; Kanban partition + `killed` column; `projectOverviews`; remove done-only semantics. |
| `packages/web/src/components/AttentionZone.tsx` | **`killed`** zone config. |
| `packages/web/src/components/SessionDetail.tsx` | Killed / restorable banner + **Restore session**. |
| `packages/web/src/components/__tests__/ProjectSidebar.test.tsx` | Update for new hook / behavior. |

**Optional:** `ShowKilledSessionsToggle.tsx` shared control for Dashboard + sidebar.

---

## Risks and open questions

| Item | Notes |
|------|--------|
| **`terminated` vs `killed`** | Toggle is **killed-only**; `terminated` stays in **Done** column. Revisit if product wants both. |
| **Exited but not yet `killed`** | May be invisible until lifecycle updates status. |
| **Exhaustive `Record<AttentionLevel, …>`** | After adding **`"killed"`**, update **`ProjectSidebar.tsx`** (`sessionDotColor`, `sessionToneLabel`, etc.) — **`getAttentionLevel` still never returns `"killed"`**, but TypeScript will require keys for the widened union. |
| **Line numbers in docs** | Verify in editor — do not rely on stale references. |
| **E2E** | No mandate in plan; manual validation sufficient unless repo adds Playwright later. |
| **Numeric issue heuristic** | `^#?\d+$` may mis-classify rare labels; adjust if a tracker uses numeric-only non-GitHub ids. |
| **PR title vs issue title** | Sidebar scheme **deprioritizes PR title** vs current `getSessionTitle`; confirm product preference (plan assumes **issue/branch-first** in the narrow list). |

---

## Validation strategy

- **Manual:** Kill a worker; toggle **off** → hidden in sidebar / overview / board; **on** → appears under **Killed** / project list; open **Session detail** → banner + **Restore** → session recovers after API success. **Merged** sessions remain in **Done**, unaffected by toggle. Ctrl+click sidebar links; collapsed **+** opens modal. **Sidebar:** labels stay stable (no random summary text); numeric issues show **GitHub title** after enrichment; **branch** subtitle helps tell sessions apart.  
- **Automated:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test` from repo root.

---

## Implementation checklist

### Phase 1 — Preference + data

- [ ] **1.1** Add `useShowKilledSessions` + storage key + sync events; remove **`useShowDone.ts`** and all imports.  
- [ ] **1.2** Add **`isKilledSession`** + extend **`AttentionLevel`** with **`"killed"`**.  
- [ ] **1.3** `layout.tsx`: drop `active=true`; pass **`orchestrators`** to **`ProjectSidebar`**.  
- [ ] **1.4** **`AttentionZone`:** **`killed`** column config.

### Phase 2 — Dashboard + sidebar visibility

- [ ] **2.1** **`Dashboard.tsx`:** Replace done-toggle with **Show killed sessions**; split **Done** vs **Killed** columns; fix **`hasAnySessions`** for killed-only fleets.  
- [ ] **2.2** **`projectOverviews`:** Exclude/include killed per toggle; optional **Killed** metric.  
- [ ] **2.3** **`ProjectSidebar`:** Filter workers by **`showKilled || !isKilledSession`**; expanded toggle UI.

### Phase 3 — Session detail restore

- [ ] **3.1** **`SessionDetail.tsx`:** Banner for killed (and/or restorable terminal); **Restore session** → same API as dashboard; refresh state on success.

### Phase 4 — Sidebar UX (navigation + spawn)

- [ ] **4.1** All Projects: **`cursor-pointer`**.  
- [ ] **4.2** Project header: expand-only; dashboard + orchestrator **`<a>`**s.  
- [ ] **4.3** Collapsed: per-project spawn + shared **`SpawnSessionModal`**.

### Phase 5 — Sidebar session labels

- [ ] **5.1** Implement **`getSessionSidebarLabel`** in **`format.ts`** (no summary in default chain; numeric vs non-numeric **`issueLabel`** behavior per §I).  
- [ ] **5.2** **`ProjectSidebar`:** use it for expanded row title + collapsed abbr source; optional **second line** for **`branch`**.  
- [ ] **5.3** **`format.test.ts`:** cover slug vs `#123`, issueTitle precedence, branch fallback.

### Phase 6 — Quality gate

- [ ] **6.1** Update **`ProjectSidebar.test.tsx`** (and any hook tests if added).  
- [ ] **6.2** `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.  
- [ ] **6.3** Commit: e.g. `feat(web): show killed sessions toggle, restore on detail, sidebar labels (#…)` linking **fix-killed-session-toggle**.  
- [ ] **6.4** Push **`feat/fix-killed-session-toggle`**, PR base **`gb-personal`**.

---

## Notes for implementer

- Branch from **`gb-personal`**; do not commit directly to default branch.  
- While implementing, move this file to **`.feature-plans/wip/`**; when merged, to **`.feature-plans/done/`**.
