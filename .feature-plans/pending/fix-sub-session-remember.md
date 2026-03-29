# Feature Plan: Fix Sub-Session Remember on Session Return

**Issue:** fix-sub-session-remember
**Branch:** `feat/fix-sub-session-remember`
**Status:** Planning
**Target:** gb-personal

---

## Problem Summary

When a user:
1. Opens session A
2. Creates and selects sub-session T1 (clicks the tab)
3. Navigates to a different session B (in the same dashboard)
4. Returns to session A

**Expected:** The UI shows T1 (the last selected sub-session) with its terminal output
**Actual:** The UI shows the primary "Agent" tab instead

The selected sub-session state is not being restored when returning to a session, even though it's saved to `sessionStorage`. This happens because the state is stored only in `sessionStorage`, which can be lost or not properly restored due to component lifecycle issues during navigation.

---

## Root Cause Analysis

**Current Implementation:**
- `SessionTerminalTabs.tsx` uses `sessionStorage` to persist the selected sub-session ID (key: `workspace:active-terminal-tab:{sessionId}`)
- State is saved on every `activeId` change (line 131-132)
- State is loaded on component mount (line 82-107)

**Issues:**
1. **Client-only persistence:** `sessionStorage` only persists within the browser tab and doesn't survive page reloads
2. **Component lifecycle issue:** When switching between sessions via Next.js routing, the effect that restores the state might not complete before the UI renders
3. **No server-side record:** The selected sub-session is not persisted to the session metadata, so it can't be restored reliably on session restoration

**Symptom:** The restore effect on line 72-117 runs, but by the time it sets `activeId`, the UI may have already rendered with the default (primary) tab selected.

---

## Proposed Approach

### Option A: Enhanced Client-Side Persistence (Recommended)
Improve the restore logic in `SessionTerminalTabs` to:
1. Save the selected sub-session to `sessionStorage` (already done)
2. Load it from `sessionStorage` on mount (already done)
3. **Fix the timing issue:** Ensure the state is applied **before** the first render by restructuring the effect

### Option B: Server-Side Persistence
1. Add `activeSubSessionId` to session metadata
2. Save it via API when a sub-session is selected
3. Load it from session metadata on page load
4. Restore it in the component

**Recommendation:** Start with Option A (client-side fix) because:
- No API changes required
- Simpler implementation
- `sessionStorage` is appropriate for per-session UI state
- The bug is likely a timing issue, not a storage issue

---

## Research Findings

### How SessionTerminalTabs Works
- **Line 45-62:** `loadSubs()` fetches sub-sessions from `/api/sessions/:id/sub-sessions`
- **Line 72-117:** Effect that loads sub-sessions, restores saved state, and optionally restores dead terminals
- **Line 128-132:** Effect that saves `activeId` to `sessionStorage` whenever it changes
- **Line 134-156:** `selectTab()` handler that switches tabs and optionally restores dead terminals

### Current Effect Dependencies
- Effect 1 (line 65-69): Resets state when `sessionId` changes → depends on `[sessionId]`
- Effect 2 (line 72-117): Loads and restores state → depends on `[sessionId, loadSubs]`
- Effect 3 (line 120-125): Fallback when active tab is not in list → depends on `[subs, activeId]`
- Effect 4 (line 128-132): Saves state → depends on `[sessionId, activeId, subs]`

### Potential Race Condition
When `sessionId` changes (navigating between sessions):
1. Effect 1 runs, setting `activeId` back to `sessionId` (the primary)
2. Effect 2 should then restore from `sessionStorage`
3. But if Effect 2 hasn't completed before render, the primary tab is displayed

### sessionStorage Key Format
```
workspace:active-terminal-tab:{sessionId}
```
Example: `workspace:active-terminal-tab:int-1`

Stored value:
```json
{
  "subSessionId": "int-1-t1",
  "updatedAt": 1706000000000
}
```

---

## Proposed Solution Details

### Fix: Ensure State Restoration Before First Render

The issue is that `activeId` is set to `sessionId` (primary) on line 68, and the restore effect (line 72-117) tries to override it. However, due to async operations, the restore might not complete in time.

**Solution:**
1. **Reorder useEffect hooks** or **restructure the restore logic** to ensure `activeId` is set to the restored value before React renders
2. **Add explicit state coordination** by having the restore effect directly set `activeId` without awaiting sub-session loading

### Implementation Approach

#### Step 1: Improve the restore effect structure
- Load persisted sub-session state **synchronously** from `sessionStorage` (it's already cached)
- Check if the stored sub-session exists in the list **after** sub-sessions are loaded
- Apply the restored state as soon as the list is available
- Handle edge cases:
  - Stored sub-session doesn't exist in current list (fall back to primary)
  - Stored sub-session is a dead terminal (attempt restore if needed)

#### Step 2: Add defensive checks
- Verify that `activeId` is set to a valid sub-session ID from the list
- Add fallback logic if restore fails

#### Step 3: Consider localStorage as fallback (Optional)
- Use `localStorage` as a secondary fallback for longer-lived state
- Only use if `sessionStorage` is unavailable
- This would survive page reloads

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/components/SessionTerminalTabs.tsx` | Fix restore effect logic to ensure state is applied reliably before render |
| `packages/web/src/components/workspace/sessionTerminalTabState.ts` | (Optional) Add localStorage fallback |

---

## Changes in Detail

### SessionTerminalTabs.tsx

**Issue:** The restore effect (lines 72-117) runs async operations (`loadSubs()`), and by the time it updates `activeId`, the first render might have already happened with `activeId` still set to `sessionId`.

**Fix:** Load the stored state **synchronously** at the start of the effect, and apply it as soon as sub-sessions are loaded, without additional delays.

**Current logic (line 82-110):**
```typescript
const stored = loadSessionTerminalTabState(sessionId);
let nextId = sessionId;  // default to primary

if (stored?.subSessionId) {
  const match = list.find((s) => s.id === stored.subSessionId);
  if (match) {
    if (match.type === "terminal" && !match.alive) {
      // async restore attempt
      ...
    } else {
      nextId = stored.subSessionId;  // already in list and alive
    }
  }
}

if (!cancelled) {
  setActiveId(nextId);  // might not execute before first render
}
```

**Improved logic:**
1. Move the `stored` load outside the async function
2. Immediately check if `stored.subSessionId` is in the fresh list
3. Set `activeId` synchronously if the stored tab exists and is alive
4. Only attempt async restore if the tab is dead

```typescript
// Synchronously load stored state first
const stored = loadSessionTerminalTabState(sessionId);
let nextId = sessionId;

// Load sub-sessions
const list = await loadSubs();
if (!cancelled && list?.length) {
  // Check if stored sub-session is still available
  if (stored?.subSessionId) {
    const match = list.find((s) => s.id === stored.subSessionId);
    if (match && match.type === "primary") {
      nextId = match.id;  // primary always exists
    } else if (match && match.type === "terminal") {
      if (match.alive) {
        nextId = match.id;  // terminal is alive, use it
      } else if (match.alive === false) {
        // Terminal is dead, attempt restore
        nextId = await attemptRestoreDeadTerminal(match);
      }
    }
  }

  // Set active ID after determining the correct one
  if (!cancelled) {
    setActiveId(nextId);
  }
}
```

### sessionTerminalTabState.ts (Optional Enhancement)

Add localStorage fallback for longer-term persistence:

```typescript
function getStorageKey(parentSessionId: string): string {
  return `workspace:active-terminal-tab:${parentSessionId}`;
}

function getLocalStorageKey(parentSessionId: string): string {
  return `workspace:active-terminal-tab-persistent:${parentSessionId}`;
}

export function loadSessionTerminalTabState(parentSessionId: string): SessionTerminalTabState | null {
  // Try sessionStorage first
  const fromSession = window.sessionStorage?.getItem(getStorageKey(parentSessionId));
  if (fromSession) {
    try {
      const parsed = JSON.parse(fromSession) as Partial<SessionTerminalTabState>;
      if (parsed.subSessionId) return { ...parsed as SessionTerminalTabState };
    } catch {
      // fall through
    }
  }

  // Fall back to localStorage
  const fromLocal = window.localStorage?.getItem(getLocalStorageKey(parentSessionId));
  if (fromLocal) {
    try {
      const parsed = JSON.parse(fromLocal) as Partial<SessionTerminalTabState>;
      if (parsed.subSessionId) {
        // Copy it back to sessionStorage for consistency
        window.sessionStorage?.setItem(getStorageKey(parentSessionId), fromLocal);
        return { ...parsed as SessionTerminalTabState };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export function saveSessionTerminalTabState(parentSessionId: string, subSessionId: string): void {
  const state: SessionTerminalTabState = {
    subSessionId,
    updatedAt: Date.now(),
  };
  const json = JSON.stringify(state);

  // Save to both sessionStorage and localStorage
  window.sessionStorage?.setItem(getStorageKey(parentSessionId), json);
  window.localStorage?.setItem(getLocalStorageKey(parentSessionId), json);
}
```

---

## Validation Strategy

### Manual Testing
1. **Test case 1: Select a terminal tab and switch sessions**
   - Open session A
   - Create sub-session T1
   - Click T1 tab (should show T1 terminal)
   - Click on a different session B in the sidebar
   - Click back to session A
   - **Verify:** T1 tab is selected and showing (not Agent tab)

2. **Test case 2: Select primary tab and switch sessions**
   - Open session A
   - Stay on Agent tab
   - Navigate to session B and back
   - **Verify:** Agent tab is still selected

3. **Test case 3: Select a terminal that gets killed**
   - Open session A
   - Create T1, select it
   - Kill the T1 terminal in the shell (exit)
   - Navigate to another session and back
   - **Verify:** Attempt to restore T1, if successful show it, else fall back to Agent

4. **Test case 4: Multiple sessions**
   - Open session A, select T1
   - Open session B, select T2
   - Go back to A
   - **Verify:** A shows T1, not Agent
   - Go back to B
   - **Verify:** B shows T2, not Agent

### Unit Tests
- Test `loadSessionTerminalTabState()` with various inputs
- Test `saveSessionTerminalTabState()` persistence
- Test SessionTerminalTabs component mounting with stored state
- Test switching between sessions and state restoration

---

## Risks and Open Questions

| # | Risk/Question | Mitigation |
|---|---------------|-----------|
| 1 | **Effect ordering:** If effects run in unexpected order, state might not restore | Add explicit test case; use `lastInitSessionRef` tracking |
| 2 | **localStorage quota exceeded:** If user has many sessions | Clear old entries; use smaller state object |
| 3 | **Stored sub-session doesn't exist:** (e.g., manually deleted) | Fallback to primary tab, same as current behavior |
| 4 | **Sub-session is dead on return:** Need to restore it | Use existing `POST /api/sessions/:id/sub-sessions/:subId/restore` endpoint |

---

## Implementation Checklist

- [ ] **1.0** Read current code and understand the full flow
- [ ] **1.1** Identify the exact timing issue causing the bug
- [ ] **1.2** Refactor restore effect in `SessionTerminalTabs.tsx`:
  - [ ] Restructure to load stored state early
  - [ ] Apply state before or immediately after sub-sessions load
  - [ ] Handle dead terminal restoration
- [ ] **1.3** Update `sessionTerminalTabState.ts` (optional):
  - [ ] Add localStorage fallback
  - [ ] Update save logic to persist to both storages
- [ ] **1.4** Test locally:
  - [ ] Manual test all 4 test cases above
  - [ ] Verify no regressions in tab switching
  - [ ] Check edge cases (dead terminals, missing sub-sessions)
- [ ] **1.5** Run full test suite:
  - [ ] `pnpm build`
  - [ ] `pnpm typecheck`
  - [ ] `pnpm lint`
  - [ ] `pnpm test`
- [ ] **1.6** Push to branch and open PR

---

## Notes

- The feature plan for "restore-agent-override-and-sub-sessions" was already implemented (PR #9), so this is a bug fix for that feature
- No API changes required unless we add server-side persistence (not recommended for this fix)
- The fix should be isolated to the frontend component and storage utility
- Existing tests should continue to pass
