# Feature Plan: Auto-open plan in file preview on first visit

**Issue:** open-plan-first-time
**Branch:** `feat/open-plan-first-time`
**Status:** Pending

---

## Problem

- When an agent creates a feature plan in `.feature-plans/`, the UI shows no file in the preview pane
- User has to manually navigate the file tree to find and open the plan
- The plan is the primary deliverable of the planning phase — it should surface automatically

## Research

### File preview state storage — `sessionFileState.ts`

- **File:** `packages/web/src/components/workspace/sessionFileState.ts:1`
- **Trigger:** `WorkspaceLayout` calls `loadSessionFileState(session.id)` on mount to restore last-opened file
- **Storage:** `sessionStorage` keyed by `workspace:last-opened:{sessionId}`
- **Risk:** LOW — sessionStorage is browser-only; CLI cannot write to it

### WorkspaceLayout file restoration — `WorkspaceLayout.tsx`

- **File:** `packages/web/src/components/workspace/WorkspaceLayout.tsx:110-125`
- **Trigger:** `useEffect` on session change; reads sessionStorage, falls back to null
- **Current fallback:** `restoredFile = stored?.filePath ?? null` — no server-side hint used
- **Risk:** LOW — adding a metadata fallback here does not break existing behavior

### Session metadata — `packages/core/src/metadata.ts`

- **File:** `packages/core/src/metadata.ts:155-180`
- **Key function:** `updateMetadata(dataDir, sessionId, updates)` — merges partial key-value pairs
- **Risk:** LOW — arbitrary string keys are already supported; `readMetadataRaw` exposes them

### `DashboardSession.metadata` flow

- **File:** `packages/web/src/lib/serialize.ts:53-69` — `sessionToDashboard` passes `session.metadata` directly
- **File:** `packages/web/src/lib/types.ts:87` — `metadata: Record<string, string>`
- **Risk:** NONE — `metadata` is already fully passed through to the UI

### CLI session commands — `packages/cli/src/commands/session.ts`

- **File:** `packages/cli/src/commands/session.ts:11`
- **Pattern:** subcommands added via `session.command(...).action(...)` — follow same pattern
- **Risk:** LOW — adding a new leaf subcommand

### Agent base prompt — `packages/core/src/prompt-builder.ts`

- **File:** `packages/core/src/prompt-builder.ts:23-65` — `BASE_AGENT_PROMPT`
- **Risk:** LOW — adding one instruction line to the planning workflow section

## Root Cause

- No mechanism exists for the agent to "pre-select" a file in the web preview
- `WorkspaceLayout` only reads from browser `sessionStorage` — CLI/server cannot write there
- No server-side hint field exists in session metadata for UI state

## Approach

### Fix 1: New CLI subcommand `ao session open-plan`

- Add `session.command("open-plan")` in `packages/cli/src/commands/session.ts`
- Accepts `<file-path>` arg + optional `[session]` arg (falls back to `AO_SESSION_NAME` env var)
- Calls `updateMetadata(dataDir, sessionId, { pendingPreviewFile: filePath })` using core API
- Command is intentionally simple — no UI side-effects, no HTTP, just writes metadata

### Fix 2: WorkspaceLayout reads metadata hint as fallback

- In `packages/web/src/components/workspace/WorkspaceLayout.tsx`, extend the `useEffect` that reads `sessionStorage`
- After `loadSessionFileState` returns null, check `session.metadata['pendingPreviewFile']`
- Use that as `restoredFile` only when sessionStorage has no entry (first-visit behaviour)
- No need to clear the metadata field — sessionStorage wins on subsequent visits, and after tab close the hint naturally re-applies (desired: "whenever user goes to that session again")
- Add `session.metadata` to `useEffect` dependency array so the hint is re-read when SSE delivers fresh session data

### Fix 3: Add instruction to agent base prompt

- In `packages/core/src/prompt-builder.ts`, add to the Planning workflow section:
  ```
  After saving the plan, run: ao session open-plan <relative-path-to-plan>
  This pre-loads the plan in the file preview for the user's next visit to this session.
  Run it only once, immediately after writing the plan file.
  ```
- This ensures every agent automatically signals the plan location without being told explicitly

## Files to Modify

| File | Change |
|------|--------|
| `packages/cli/src/commands/session.ts` | Add `open-plan` subcommand |
| `packages/web/src/components/workspace/WorkspaceLayout.tsx` | Read `session.metadata.pendingPreviewFile` as fallback |
| `packages/core/src/prompt-builder.ts` | Add `ao session open-plan` instruction to `BASE_AGENT_PROMPT` |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **What if the file path doesn't exist when the user visits?** | `FilePreview` already handles missing files gracefully (shows empty state); no crash |
| 2 | **Should the hint be cleared after first use?** | No — sessionStorage takes over on subsequent navigations within the same tab; after tab close re-showing the plan is desirable |
| 3 | **Path format: relative vs absolute?** | Store relative path (e.g. `.feature-plans/pending/foo.md`); the file tree and `useFileContent` hook already work with workspace-relative paths |
| 4 | **What if the user is already viewing a different file?** | sessionStorage check comes first — the hint only fires when no prior file is stored; existing user selections are never overridden |
| 5 | **Should preview pane be forced open?** | `ensurePreviewVisible()` already exists in `WorkspaceLayout` — call it when the hint fires to ensure the preview pane is visible |

## Validation

- Manual: spawn a session, have it run `ao session open-plan .feature-plans/pending/test.md`, navigate to the session in a fresh tab — plan should open in preview
- Manual: verify that selecting another file (via file tree) persists in sessionStorage and overrides the hint on second visit
- Manual: verify the hint does not change the UI if user is viewing another session/project at the time the command runs
- Type check: `pnpm typecheck` — no new types needed; `session.metadata` is already `Record<string, string>`
- Unit test: add test for the new CLI subcommand (validate metadata write)

## Checklist

### Phase 1 — CLI command

- [ ] **1.1** Add `session.command("open-plan")` subcommand in `packages/cli/src/commands/session.ts`
  - Arg: `<file-path>` (required)
  - Arg: `[session]` (optional, defaults to `AO_SESSION_NAME` env var)
  - Load config → get session manager → call `updateMetadata` with `pendingPreviewFile`
  - Print success with the file path and session ID
- [ ] **1.2** Export `updateMetadata` and `getSessionsDir` (or similar) from core if not already accessible in CLI context; verify `getSessionManager` provides the `dataDir` needed
- [ ] **1.3** Write a unit test for the command in `packages/cli/src/__tests__/session-open-plan.test.ts`

### Phase 2 — Web UI fallback

- [ ] **2.1** In `WorkspaceLayout.tsx`, extend the `useEffect` at line ~114:
  - After `loadSessionFileState` returns null, read `session.metadata['pendingPreviewFile']`
  - Cast with a type guard: `typeof hint === 'string' && hint.length > 0`
  - Set `restoredFile` to the hint value
  - Call `ensurePreviewVisible()` after setting the hint (so preview pane auto-opens)
- [ ] **2.2** Add `session.metadata` (or `session`) to `useEffect` dependency array
- [ ] **2.3** Write a test in `packages/web/src/components/__tests__/WorkspaceLayout.openPlan.test.tsx`
  - Test: renders with metadata hint → hint file is selected
  - Test: renders with both sessionStorage entry and metadata hint → sessionStorage wins

### Phase 3 — Agent prompt

- [ ] **3.1** Add the `ao session open-plan` instruction to `BASE_AGENT_PROMPT` in `packages/core/src/prompt-builder.ts`
  - Place it at the end of the "Planning workflow" section, after the plan storage instructions
  - Exact wording: single bullet, imperative tone, matches existing style

### Phase 4 — Integration check

- [ ] **4.1** `pnpm build` — verify no build errors
- [ ] **4.2** `pnpm typecheck` — verify no type errors
- [ ] **4.3** `pnpm lint` — verify no lint errors
- [ ] **4.4** `pnpm test` — verify all tests pass
