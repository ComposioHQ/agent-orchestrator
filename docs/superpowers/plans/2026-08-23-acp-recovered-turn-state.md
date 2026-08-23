# ACP Recovered Turn State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Represent an unbounded ACP `session/load` tail as recovered instead of inferring completion, interruption, or failure.

**Architecture:** Add one shared terminal domain state and carry it through storage, API, and presentation. Generic ACP history assigns it only to the final replay tail; service-level reconciliation retains stronger terminal AO evidence.

**Tech Stack:** Go 1.25, ACP Go SDK v0.13.5, SQLite/sqlc, code-first OpenAPI, React/TypeScript/Vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-acp-recovered-turn-state-design.md`

## Global Constraints

- `recovered` is terminal but does not assert success, failure, or cancellation.
- Every final unbounded ACP replay tail is recovered regardless of provider output.
- A later user boundary proves the preceding turn completed.
- Known AO terminal state wins reconciliation; queued/running AO state does not.
- SQLite needs no migration because turn state is stored as text.
- Running activities on a recovered turn settle as cancelled.
- Regenerate OpenAPI and the frontend schema together with `npm run api`.

---

### Task 1: Rebase onto current main

**Files:** Preserve all PR files plus the approved spec and this plan.

**Interfaces:** Produces a clean PR head based on current `untrivial/main`.

- [ ] **Step 1: Record exact heads**

```bash
git status --short
git fetch untrivial main refs/heads/ao/agent-orchestrator-228/cursor-acp-chat
git rev-parse HEAD untrivial/main refs/remotes/untrivial/ao/agent-orchestrator-228/cursor-acp-chat
```

- [ ] **Step 2: Rebase surgically**

```bash
git rebase untrivial/main
```

Preserve current-main history/error handling plus the PR's narrow Cursor extension, permission validation, and context propagation. Never take a generic ACP driver file wholesale.

- [ ] **Step 3: Verify the baseline**

```bash
git diff --check untrivial/main...HEAD
cd backend
go test ./internal/adapters/chatdriver/acp ./internal/service/chat
```

Expected: PASS before behavior changes.

---

### Task 2: Add the shared lifecycle and storage policy

**Files:**
- Modify: `backend/internal/domain/conversation.go`
- Modify: `backend/internal/domain/sessionmode_test.go`
- Modify: `backend/internal/storage/sqlite/store/conversation_store.go`
- Modify: `backend/internal/storage/sqlite/store/conversation_history_store_test.go`

**Interfaces:** Produces `domain.TurnStateRecovered = "recovered"`, terminal semantics, and neutral activity settlement.

- [ ] **Step 1: Write failing tests**

Add `{TurnStateRecovered, true}` to `TestTurnStateTerminal`. Add `TestRecoveredTurnSettlesRunningActivityAsCancelled` that seeds a running command activity, calls:

```go
err := s.SettleTurn(ctx, conversation, "provider-turn-1",
    domain.TurnStateRecovered, "", histClock.Add(time.Minute))
```

and asserts the stored turn is recovered and its running activity is cancelled.

- [ ] **Step 2: Verify RED**

```bash
cd backend
go test ./internal/domain ./internal/storage/sqlite/store -run 'TestTurnStateTerminal|TestRecoveredTurnSettlesRunningActivityAsCancelled' -count=1
```

Expected: compile failure because `TurnStateRecovered` is undefined.

- [ ] **Step 3: Implement minimally**

Add:

```go
TurnStateRecovered TurnState = "recovered"
```

Include it in `TurnState.Terminal()`. In `terminalActivityStatus` use:

```go
case domain.TurnStateInterrupted, domain.TurnStateRecovered:
    return domain.ActivityStatusCancelled
```

- [ ] **Step 4: Verify GREEN and commit**

```bash
go test ./internal/domain ./internal/storage/sqlite/store -run 'TestTurnStateTerminal|TestRecoveredTurnSettlesRunningActivityAsCancelled' -count=1
git add backend/internal/domain backend/internal/storage/sqlite/store/conversation_store.go backend/internal/storage/sqlite/store/conversation_history_store_test.go
git commit -m "feat: add recovered conversation turn state"
```

---

### Task 3: Apply the policy in generic ACP replay and reconciliation

**Files:**
- Modify: `backend/internal/adapters/chatdriver/acp/history.go`
- Modify: `backend/internal/adapters/chatdriver/acp/driver_test.go`
- Modify: `backend/internal/service/chat/controller.go`
- Modify: `backend/internal/service/chat/controller_test.go`

**Interfaces:** Final ACP tails are recovered; bounded turns remain completed; mapped terminal AO states remain authoritative.

- [ ] **Step 1: Change replay expectations first**

Change the answered-tail and user-only-tail assertions to `domain.TurnStateRecovered`. Keep the bounded first turn completed.

- [ ] **Step 2: Verify RED**

```bash
cd backend
go test ./internal/adapters/chatdriver/acp -run 'TestACPDriverLoadsSettledHistoryWhenTheAgentCanReplayIt|TestACPDriverLoadsUserOnlyTail' -count=1
```

Expected: FAIL with completed/interrupted instead of recovered.

- [ ] **Step 3: Implement one generic tail rule**

Make `finishHistoryReplay` call:

```go
c.finishHistoryTurn(domain.TurnStateRecovered)
```

Remove `turnHasProvider` and its writes. Keep the existing later-user-boundary path settling the preceding turn completed.

- [ ] **Step 4: Lock reconciliation semantics**

Add table coverage around `reconcileNativeHistory` with a recovered replay completion:

```go
tests := []struct {
    existing domain.TurnState
    want     domain.TurnState
}{
    {domain.TurnStateCompleted, domain.TurnStateCompleted},
    {domain.TurnStateInterrupted, domain.TurnStateInterrupted},
    {domain.TurnStateFailed, domain.TurnStateFailed},
    {domain.TurnStateRunning, domain.TurnStateRecovered},
}
```

Also assert an unmatched provider-only replay stays recovered. Update the reconciliation comment to describe protocol-unknown recovered state.

- [ ] **Step 5: Verify and commit**

```bash
go test ./internal/adapters/chatdriver/acp ./internal/service/chat -count=1
git add backend/internal/adapters/chatdriver/acp/history.go backend/internal/adapters/chatdriver/acp/driver_test.go backend/internal/service/chat/controller.go backend/internal/service/chat/controller_test.go
git commit -m "fix: recover unknown ACP replay outcomes"
```

---

### Task 4: Expose and render recovered turns

**Files:**
- Modify: `backend/internal/httpd/controllers/dto.go`
- Regenerate: `backend/internal/httpd/apispec/openapi.yaml`
- Regenerate: `frontend/src/api/schema.ts`
- Modify: `frontend/src/renderer/types/conversation.ts`
- Modify: `frontend/src/renderer/components/chat/ChatWorkspace.tsx`
- Modify: `frontend/src/renderer/components/chat/ChatTimelineItems.tsx`
- Create: `frontend/src/renderer/components/chat/TurnOutcome.test.tsx`

**Interfaces:** API and frontend `TurnState` include `recovered`; `TurnOutcome` renders it neutrally.

- [ ] **Step 1: Write the failing UI test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TurnOutcome } from "./ChatTimelineItems";

describe("TurnOutcome", () => {
    it("renders recovered history neutrally", () => {
        render(<TurnOutcome state="recovered" />);
        expect(screen.getByText("Recovered")).toBeInTheDocument();
        expect(screen.getByText("Recovered")).not.toHaveClass("text-destructive");
    });
});
```

- [ ] **Step 2: Verify RED**

```bash
cd frontend
npm test -- --run src/renderer/components/chat/TurnOutcome.test.tsx
```

Expected: type/test failure because recovered is not accepted.

- [ ] **Step 3: Update API source and regenerate**

Add `recovered` to both turn-state enum tags in `dto.go`, then run:

```bash
cd ../
npm run api
```

- [ ] **Step 4: Update frontend unions and copy**

Add `"recovered"` to `TurnState`, `TimelineGroup.outcome.state`, and `TurnOutcome` props. Add:

```ts
recovered: { label: "Recovered", tone: "text-muted-foreground/70" },
```

- [ ] **Step 5: Verify and commit**

```bash
cd frontend
npm test -- --run src/renderer/components/chat/TurnOutcome.test.tsx
npm run typecheck
cd ../backend
go test ./internal/httpd/...
cd ..
git add backend/internal/httpd frontend/src/api/schema.ts frontend/src/renderer
git commit -m "feat: expose recovered chat turns"
```

---

### Task 5: Review, verify, push, and reply

**Files:** Review every file in `untrivial/main...HEAD`; update the existing inline GitHub thread after push.

**Interfaces:** Produces a conflict-free, independently reviewed PR head with passing CI.

- [ ] **Step 1: Run local verification**

```bash
cd backend
go test -race ./internal/adapters/chatdriver/acp ./internal/service/chat ./internal/storage/sqlite/store -count=1
go build ./...
go vet ./...
go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2 run --allow-parallel-runners --path-mode=abs
cd ..
npm run frontend:typecheck
npm run lint
git diff --check untrivial/main...HEAD
```

- [ ] **Step 2: Request independent review**

Use `superpowers:requesting-code-review` against `untrivial/main...HEAD`. Require findings on domain semantics, ACP boundaries, reconciliation, activity settlement, API generation, and frontend exhaustiveness. Fix every Critical or Important finding and rerun affected checks.

- [ ] **Step 3: Refresh and push safely**

```bash
git fetch untrivial main refs/heads/ao/agent-orchestrator-228/cursor-acp-chat
git rebase untrivial/main
git push --force-with-lease=refs/heads/ao/agent-orchestrator-228/cursor-acp-chat untrivial HEAD:refs/heads/ao/agent-orchestrator-228/cursor-acp-chat
```

- [ ] **Step 4: Reply and monitor**

Reply in the original inline review thread with the commit, recovered-state semantics, reconciliation rule, and verification evidence. Then run:

```bash
gh pr checks 4201 --repo Untrivial-ai/agent-orchestrator --watch --interval 10
```

Expected: all required checks pass and GitHub reports the PR mergeable.
