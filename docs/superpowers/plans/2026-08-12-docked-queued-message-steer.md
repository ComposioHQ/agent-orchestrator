# Docked Queued-Message Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep queued prompts visible directly above the composer and let users steer any individual queued prompt into the running Claude Code turn.

**Architecture:** Derive ordered queued prompt view models from the existing conversation snapshot in `ChatWorkspace`. Render them through a focused dock component in the composer area and reuse the existing `onPromoteQueuedTurn(turnId)` API callback; no backend or schema changes are needed.

**Tech Stack:** React, TypeScript, TanStack Query mutation callbacks, Vitest, Testing Library.

## Global Constraints

- Keep `Stop and clear queue` behavior unchanged.
- Keep queued prompts in the timeline for chronology, without a duplicate timeline steering action.
- Show steering only when the harness exposes the existing steering callback.
- Preserve queue order, per-card pending/error state, and visibility after conversation branching.
- Do not add delete or overflow actions.

---

### Task 1: Dock queued prompts above the composer

**Files:**
- Modify: `frontend/src/renderer/components/chat/ChatSteer.test.tsx`
- Modify: `frontend/src/renderer/components/chat/ChatWorkspace.tsx`
- Modify: `frontend/src/renderer/components/chat/ChatTimelineItems.tsx`

**Interfaces:**
- Consumes: `ConversationSnapshot`, `queuedTurnIds(snapshot)`, and `onPromoteQueuedTurn?: (turnId: string) => Promise<unknown>`.
- Produces: `QueuedMessageDock`, which renders ordered queued human messages and invokes promotion with the selected turn ID.

- [ ] **Step 1: Write failing renderer tests**

Add tests to `ChatSteer.test.tsx` that render the existing `withQueuedMessages()` snapshot and assert:

```tsx
expect(screen.getByTestId("queued-message-dock")).toBeInTheDocument();
expect(within(screen.getByTestId("queued-message-dock")).getByText("first queued")).toBeVisible();
expect(within(screen.getByTestId("queued-message-dock")).getByText("second queued")).toBeVisible();
```

Click the second dock card's `Steer` action and assert the existing callback receives literal turn ID `queued-2`. Render the same fixture with `branchedFromEarlierMessage: true` and assert the dock remains present. Assert the whole rendered workspace has exactly two `Steer` actions and no `Steer now` actions, proving actions moved rather than duplicated.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd frontend
PATH=/Users/nikhilachale/.nvm/versions/node/v24.18.1/bin:$PATH npm test -- --run src/renderer/components/chat/ChatSteer.test.tsx
```

Expected: FAIL because `queued-message-dock` and dock-scoped `Steer` controls do not exist.

- [ ] **Step 3: Implement ordered queued-message derivation**

In `ChatWorkspace.tsx`, derive queued human messages by iterating `snapshot.turns` in snapshot order, selecting turns with `state === "queued"`, then finding each turn's human-origin user message in `snapshot.items`. Pass `{ turnId, message }` records to a focused `QueuedMessageDock` component.

Render the dock between `LiveTurnBar` and `ChatComposer`. Each compact card must display `message.text`; show a `Steer` button only when `onPromoteQueuedTurn` exists and the active turn is running.

- [ ] **Step 4: Move steering ownership out of timeline bubbles**

Stop passing `onPromoteQueuedTurn` through `Timeline`, `TurnGroup`, `TimelineItem`, and `HumanMessage`. Remove the old `Steer now` button and its local pending/error state from `ChatTimelineItems.tsx`. Keep queued timeline styling and delivery notes unchanged.

- [ ] **Step 5: Add per-card async state**

In `QueuedMessageDock`, track the selected pending turn and an error map keyed by turn ID. While selected, disable that action and label it `Steering…`. On rejection, keep the card rendered and show `Could not steer this message. It remains queued.` on that card only.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run the command from Step 2.

Expected: all `ChatSteer.test.tsx` tests pass.

- [ ] **Step 7: Add pending and failure regression tests**

Use a deferred promise for `queued-1` and a rejected promise for `queued-2`. Assert only the selected card displays `Steering…`, and only the rejected card displays the inline failure message while both queued texts remain visible.

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```bash
cd frontend
PATH=/Users/nikhilachale/.nvm/versions/node/v24.18.1/bin:$PATH npm test -- --run src/renderer/components/chat/ChatSteer.test.tsx src/renderer/components/chat/ChatWorkspace.test.tsx
PATH=/Users/nikhilachale/.nvm/versions/node/v24.18.1/bin:$PATH npm run typecheck
```

Expected: both test files and TypeScript compilation pass.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/renderer/components/chat/ChatSteer.test.tsx frontend/src/renderer/components/chat/ChatWorkspace.tsx frontend/src/renderer/components/chat/ChatTimelineItems.tsx
git commit -m "feat: dock queued message steering controls"
```

### Task 2: Verify in the real desktop app

**Files:**
- No production-file changes expected.

**Interfaces:**
- Consumes: the committed frontend behavior and the running local daemon on port `3002`.
- Produces: manual evidence that Claude Code shows docked queued cards and the selected card promotes successfully.

- [ ] **Step 1: Fast-forward the AO-owned branch and push**

Fast-forward `ao/agent-orchestrator-179/root` to the implementation commit and push it to `origin` without rewriting history.

- [ ] **Step 2: Restart Electron from the exact branch worktree**

Run `npm run dev` from `frontend/` with Node 24 and `AO_DEV_API_TARGET=http://127.0.0.1:3002`, using the isolated `~/.ao/dev` profile.

- [ ] **Step 3: Exercise Claude Code steering**

Start a Claude Code chat turn, queue two prompts, and verify both cards remain directly above the composer. Click the second card's `Steer`; verify it changes to `Steering…`, disappears after successful promotion, and the first queued card remains.

- [ ] **Step 4: Final verification**

Run the focused renderer tests and frontend typecheck once more from the exact pushed worktree. Confirm `git status --porcelain` is empty and local HEAD equals `origin/ao/agent-orchestrator-179/root`.
