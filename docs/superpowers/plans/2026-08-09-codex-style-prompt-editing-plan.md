# Codex-Style Prompt Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR #3676's destructive `rollback -> send` edit flow with Codex-style inline editing that forks immediately before the selected prompt, preserves the original conversation, and lets the user navigate between continuations.

**Architecture:** Keep one durable AO conversation and one active provider controller per session/worktree. A branch ledger records provider-thread lineage and the selected active branch; timeline rows are tagged with the branch active when they were created, and snapshot queries combine the active branch with its bounded ancestry. Editing creates or starts the target provider thread, atomically activates it with a new controller generation, then sends the edited prompt with the original structured content.

**Tech Stack:** Go 1.25+, SQLite/goose/sqlc, Chi/OpenAPI generation, Electron, React 19, TypeScript, TanStack Query, Tailwind v4, Vitest/Testing Library.

## Global Constraints

- Editing uses provider conversation branching and never calls conversation rollback.
- The original provider thread and AO history remain durable.
- Worktree files are never reverted, reset, copied, or deleted by conversation branching.
- Exactly one Chat controller writes to a session/worktree at a time.
- Edit appears only for a human message with a provider-accepted turn and a driver advertising `fork`.
- Editing the first prompt starts a fresh provider conversation in the same session and worktree.
- The bottom composer draft remains untouched.
- Escape cancels; Command/Ctrl+Enter sends; Enter inserts a newline.
- The primary action is Send with the composer's arrow treatment, never Save.
- Add the next available SQLite migration (`0086` after syncing with main); never modify old migrations or hand-edit sqlc output.
- Run `npm run api` after DTO changes and commit both generated API artifacts.

---

### Task 1: Targeted Codex conversation forks

**Files:**
- Modify: `backend/internal/ports/chat.go`
- Modify: `backend/internal/adapters/chatdriver/codexappserver/history.go`
- Modify: `backend/internal/adapters/chatdriver/codexappserver/history_test.go`
- Modify: `backend/internal/service/chat/history_test.go`

**Interfaces:**
- Consumes: existing `ports.ChatConversation` and Codex `thread/fork`.
- Produces: `ChatForker.Fork(context.Context, *string) (string, error)`; nil copies the whole thread and non-nil copies through that provider turn.

- [ ] **Step 1: Add failing targeted-fork tests**

Add this adapter test and retain a second test proving nil omits `lastTurnId`:

```go
func TestForkThroughTurnSendsLastTurnID(t *testing.T) {
	srv, conv := newHistoryConversation(t)
	srv.reply("thread/fork", `{"thread":{"id":"thread-2"},"cwd":"/tmp/ws"}`)
	anchor := "turn-before-edit"

	forked, err := conv.Fork(context.Background(), &anchor)
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if forked != "thread-2" {
		t.Fatalf("forked thread = %q, want thread-2", forked)
	}
	frame := srv.awaitFrame(func(f frame) bool { return f.Method == "thread/fork" })
	var params map[string]any
	if err := json.Unmarshal(frame.Params, &params); err != nil {
		t.Fatalf("decode params: %v", err)
	}
	if params["lastTurnId"] != anchor {
		t.Fatalf("lastTurnId = %#v, want %q", params["lastTurnId"], anchor)
	}
	if _, present := params["cwd"]; present {
		t.Fatal("fork must inherit the source cwd")
	}
}
```

- [ ] **Step 2: Run tests and confirm the old signature fails**

```bash
cd backend
go test ./internal/adapters/chatdriver/codexappserver ./internal/service/chat
```

Expected: compile failures at old zero-argument `Fork` implementations and test doubles.

- [ ] **Step 3: Implement targeted forking**

```go
type ChatForker interface {
	Fork(ctx context.Context, lastProviderTurnID *string) (string, error)
}

func (c *conversation) Fork(ctx context.Context, lastProviderTurnID *string) (string, error) {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	params := codexproto.ThreadForkParams{ThreadID: c.threadID}
	if lastProviderTurnID != nil {
		anchor := strings.TrimSpace(*lastProviderTurnID)
		if anchor == "" {
			return "", errors.New("fork anchor must not be blank")
		}
		params.LastTurnID = &anchor
	}
	var resp codexproto.ThreadForkResponse
	if err := c.conn.request(ctx, codexproto.MethodThreadFork, params, &resp); err != nil {
		return "", asRefusal(fmt.Errorf("thread/fork: %w", err))
	}
	if resp.Thread.ID == "" {
		return "", errors.New("thread/fork returned no thread id")
	}
	return resp.Thread.ID, nil
}
```

Update whole-history tests to call `Fork(ctx, nil)`.

- [ ] **Step 4: Run focused tests**

```bash
cd backend
go test ./internal/adapters/chatdriver/codexappserver ./internal/service/chat
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/ports/chat.go backend/internal/adapters/chatdriver/codexappserver/history.go backend/internal/adapters/chatdriver/codexappserver/history_test.go backend/internal/service/chat/history_test.go
git commit -m "feat(chat): support targeted conversation forks"
```

### Task 2: Durable conversation-branch ledger

**Files:**
- Create: `backend/internal/storage/sqlite/migrations/0086_conversation_branches.sql`
- Modify: `backend/internal/domain/conversation.go`
- Modify: `backend/internal/storage/sqlite/queries/conversations.sql`
- Modify: `backend/internal/storage/sqlite/queries/sessions.sql`
- Modify: `backend/internal/storage/sqlite/store/conversation_store.go`
- Modify: `backend/internal/storage/sqlite/migrate_burned_versions_test.go`
- Create: `backend/internal/storage/sqlite/migrate_conversation_branches_test.go`
- Create: `backend/internal/storage/sqlite/store/conversation_branch_store_test.go`
- Regenerate: `backend/internal/storage/sqlite/gen/conversations.sql.go`
- Regenerate: `backend/internal/storage/sqlite/gen/sessions.sql.go`
- Regenerate: `backend/internal/storage/sqlite/gen/models.go`

**Interfaces:**
- Consumes: immutable conversation sequence numbers and session controller generations.
- Produces: `domain.ConversationBranch`, `domain.ConversationEditAnchor`, and transactional store methods for creating and activating branches.

- [ ] **Step 1: Write failing store tests**

The central activation assertion is:

```go
func TestActivateConversationBranchMovesProviderAndGenerationTogether(t *testing.T) {
	ctx := context.Background()
	s, session, conversation := seededChatConversation(t)
	branch := domain.ConversationBranch{
		ID: "branch-child",
		ConversationID: conversation.ID,
		ProviderConversationID: "thread-child",
		ParentBranchID: conversation.ActiveBranchID,
		ForkAfterTurnID: "turn-1",
		ReplacedTurnID: "turn-2",
	}
	if err := s.CreateConversationBranch(ctx, branch, testNow); err != nil {
		t.Fatalf("CreateConversationBranch: %v", err)
	}
	if err := s.ActivateConversationBranch(ctx, session.ID, conversation.ID, branch.ID, "thread-child", "generation-child", testNow); err != nil {
		t.Fatalf("ActivateConversationBranch: %v", err)
	}
	got, found, err := s.GetSession(ctx, session.ID)
	if err != nil || !found {
		t.Fatalf("GetSession: found=%v err=%v", found, err)
	}
	if got.Metadata.ProviderConversationID != "thread-child" || got.Metadata.ControllerGeneration != "generation-child" {
		t.Fatalf("session controller metadata = %+v", got.Metadata)
	}
}
```

In `migrate_conversation_branches_test.go`, migrate to 79, seed a Chat conversation with turns/messages/activities/provider events, migrate to 86, and verify one root branch is backfilled with the session's provider conversation ID and every existing timeline row is tagged with it. Add version 86 and its exact filename to `shippedMigrations` in `migrate_burned_versions_test.go`.

- [ ] **Step 2: Run the test and confirm missing types**

```bash
cd backend
go test ./internal/storage/sqlite/store -run ConversationBranch -count=1
```

Expected: compile failure.

- [ ] **Step 3: Add migration 0086**

Create the branch table and additive branch columns:

```sql
CREATE TABLE conversation_branches (
    id                       TEXT PRIMARY KEY,
    conversation_id          TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    session_id               TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    provider_conversation_id TEXT NOT NULL DEFAULT '',
    parent_branch_id         TEXT REFERENCES conversation_branches(id) ON DELETE RESTRICT,
    fork_after_turn_id       TEXT REFERENCES conversation_turns(id) ON DELETE RESTRICT,
    replaced_turn_id         TEXT REFERENCES conversation_turns(id) ON DELETE RESTRICT,
    replacement_turn_id      TEXT REFERENCES conversation_turns(id) ON DELETE SET NULL,
    fork_after_sequence      INTEGER NOT NULL DEFAULT 0,
    created_at               TIMESTAMP NOT NULL,
    UNIQUE (conversation_id, provider_conversation_id)
);

ALTER TABLE conversations ADD COLUMN active_branch_id TEXT NOT NULL DEFAULT '';
ALTER TABLE conversation_turns ADD COLUMN branch_id TEXT NOT NULL DEFAULT '';
ALTER TABLE conversation_messages ADD COLUMN branch_id TEXT NOT NULL DEFAULT '';
ALTER TABLE conversation_activities ADD COLUMN branch_id TEXT NOT NULL DEFAULT '';
ALTER TABLE conversation_provider_events ADD COLUMN branch_id TEXT NOT NULL DEFAULT '';

INSERT INTO conversation_branches (
    id, conversation_id, session_id, provider_conversation_id, fork_after_sequence, created_at
)
SELECT c.id || ':root', c.id, c.current_session_id,
       COALESCE(s.provider_conversation_id, ''), 0, c.created_at
FROM conversations c
LEFT JOIN sessions s ON s.id = c.current_session_id;

UPDATE conversations SET active_branch_id = id || ':root';
UPDATE conversation_turns SET branch_id = conversation_id || ':root';
UPDATE conversation_messages SET branch_id = conversation_id || ':root';
UPDATE conversation_activities SET branch_id = conversation_id || ':root';
UPDATE conversation_provider_events SET branch_id = conversation_id || ':root';
```

Add indexes on `(conversation_id, parent_branch_id, fork_after_sequence)`, `conversation_turns(branch_id, requested_at)`, `conversation_messages(branch_id, sequence)`, `conversation_activities(branch_id, sequence)`, and `conversation_provider_events(branch_id, id)`. Add `AFTER INSERT` assignment triggers that replace the empty branch default with `conversations.active_branch_id`. Drop those triggers in the down migration and preserve additive columns following migration 0072.

- [ ] **Step 4: Add domain types and sqlc queries**

```go
type ConversationBranch struct {
	ID                     string    `json:"id"`
	ConversationID         string    `json:"conversationId"`
	SessionID              SessionID `json:"sessionId"`
	ProviderConversationID string    `json:"-"`
	ParentBranchID         string    `json:"parentBranchId,omitempty"`
	ForkAfterTurnID        string    `json:"forkAfterTurnId,omitempty"`
	ReplacedTurnID         string    `json:"replacedTurnId,omitempty"`
	ReplacementTurnID      string    `json:"replacementTurnId,omitempty"`
	ForkAfterSequence      int64     `json:"-"`
	Active                 bool      `json:"active"`
	CreatedAt              time.Time `json:"createdAt"`
}

type ConversationEditAnchor struct {
	ConversationID              string
	SourceBranchID              string
	ReplacedTurnID              string
	PreviousProviderTurnID      string
	ForkAfterSequence           int64
	OriginalDeliveryContentJSON string
}
```

`ForkAfterSequence` is the greatest timeline sequence strictly before the selected human message (`selected message sequence - 1`), or `0` for the first prompt. This single boundary applies consistently to ancestor turns, messages, activities, and provider events.

Add queries `InsertConversationBranch`, `SelectConversationBranch`, `SelectConversationBranches`, `SelectConversationEditAnchor`, `UpdateConversationBranchReplacement`, and `ActivateConversationBranch`. Activation runs in one transaction and updates:

```sql
UPDATE conversations SET active_branch_id = ?, updated_at = ? WHERE id = ?;
UPDATE sessions
SET provider_conversation_id = ?, controller_generation = ?, updated_at = ?
WHERE id = ? AND session_mode = 'chat' AND is_terminated = 0;
```

Require exactly one affected session row.

- [ ] **Step 5: Regenerate sqlc and implement mappings**

```bash
npm run sqlc
```

Never hand-edit `backend/internal/storage/sqlite/gen/*`.

- [ ] **Step 6: Run migration/store tests**

```bash
cd backend
go test ./internal/storage/sqlite/... -run 'ConversationBranch|ChatMode|Migrate|BurnedVersion' -count=1
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/storage/sqlite/migrations/0086_conversation_branches.sql backend/internal/domain/conversation.go backend/internal/storage/sqlite/queries/conversations.sql backend/internal/storage/sqlite/queries/sessions.sql backend/internal/storage/sqlite/store/conversation_store.go backend/internal/storage/sqlite/store/conversation_branch_store_test.go backend/internal/storage/sqlite/migrate_burned_versions_test.go backend/internal/storage/sqlite/migrate_conversation_branches_test.go backend/internal/storage/sqlite/gen
git commit -m "feat(chat): persist conversation branches"
```

### Task 3: Branch-aware snapshots and navigation metadata

**Files:**
- Modify: `backend/internal/storage/sqlite/queries/conversations.sql`
- Modify: `backend/internal/storage/sqlite/store/conversation_store.go`
- Modify: `backend/internal/storage/sqlite/store/conversation_branch_store_test.go`
- Modify: `backend/internal/service/chat/service.go`
- Modify: `backend/internal/domain/conversation.go`
- Regenerate: `backend/internal/storage/sqlite/gen/conversations.sql.go`

**Interfaces:**
- Consumes: Task 2 branch rows and `fork_after_sequence`.
- Produces: active-lineage filtering and `[]domain.ConversationBranchPoint`.

- [ ] **Step 1: Add failing source/child/nested snapshot tests**

Seed root A/B/C, fork after A, add child B2/C2, then assert:

```go
child := loadSnapshotForActiveBranch(t, store, conversation.ID, "branch-child")
assertMessageTexts(t, child.Messages, []string{"A", "B edited", "C edited"})

root := loadSnapshotForActiveBranch(t, store, conversation.ID, "branch-root")
assertMessageTexts(t, root.Messages, []string{"A", "B", "C"})
```

Add a nested branch and page-boundary case.

- [ ] **Step 2: Run tests and confirm root continuation leaks**

```bash
cd backend
go test ./internal/storage/sqlite/store -run 'BranchSnapshot|BranchPage' -count=1
```

Expected: FAIL because current queries select every visible row in the conversation.

- [ ] **Step 3: Add an active-lineage CTE to full and paged reads**

Use this form for turns, messages, activities, and provider events, preserving each query's existing cursor/limit predicates and every existing rolled-back/state filter:

```sql
WITH RECURSIVE active_path(branch_id, max_sequence) AS (
    SELECT c.active_branch_id, NULL
    FROM conversations c
    WHERE c.id = sqlc.arg(conversation_id)
    UNION ALL
    SELECT b.parent_branch_id, b.fork_after_sequence
    FROM active_path p
    JOIN conversation_branches b ON b.id = p.branch_id
    WHERE b.parent_branch_id IS NOT NULL
)
SELECT m.*
FROM conversation_messages m
JOIN active_path p ON p.branch_id = m.branch_id
LEFT JOIN conversation_turns t ON t.id = m.turn_id
WHERE m.conversation_id = sqlc.arg(conversation_id)
  AND (p.max_sequence IS NULL OR m.sequence <= p.max_sequence)
  AND (t.id IS NULL OR t.rolled_back_at IS NULL)
ORDER BY m.sequence;
```

- [ ] **Step 4: Produce branch navigation points**

```go
type ConversationBranchPoint struct {
	TurnID           string `json:"turnId"`
	Position         int    `json:"position"`
	Total            int    `json:"total"`
	PreviousBranchID string `json:"previousBranchId,omitempty"`
	NextBranchID     string `json:"nextBranchId,omitempty"`
}
```

Group the source branch and children sharing the source plus `replaced_turn_id`. Attach the point to `replaced_turn_id` on the source and `replacement_turn_id` on a child. Sort source first and children by `created_at, id`; previous/next do not wrap.

- [ ] **Step 5: Regenerate and run tests**

```bash
npm run sqlc
cd backend
go test ./internal/storage/sqlite/store ./internal/service/chat -run 'BranchSnapshot|BranchPage|BranchPoint' -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/storage/sqlite/queries/conversations.sql backend/internal/storage/sqlite/store/conversation_store.go backend/internal/storage/sqlite/store/conversation_branch_store_test.go backend/internal/storage/sqlite/gen/conversations.sql.go backend/internal/service/chat/service.go backend/internal/domain/conversation.go
git commit -m "feat(chat): read active conversation branches"
```

### Task 4: Safe controller handoff, edit send, and branch switching

**Files:**
- Modify: `backend/internal/service/chat/controller.go`
- Modify: `backend/internal/service/chat/service.go`
- Modify: `backend/internal/service/chat/history.go`
- Modify: `backend/internal/service/chat/history_test.go`
- Modify: `backend/internal/service/chat/controller_test.go`
- Modify: `backend/internal/storage/sqlite/store/conversation_store.go`

**Interfaces:**
- Consumes: targeted `ChatForker`, branch store methods, and the active controller's `StartConfig`.
- Produces: `Service.EditMessage` and `Service.ActivateBranch`.

- [ ] **Step 1: Add failing middle/first/busy/failure tests**

```go
result, err := h.svc.EditMessage(ctx, testSession, "turn-2", ports.ChatUserMessage{
	Text: "edited prompt",
	ClientMessageID: "edit-1",
	Origin: domain.MessageOriginHuman,
})
if err != nil {
	t.Fatalf("EditMessage: %v", err)
}
if result.SourceBranchID != "branch-root" || result.ActiveBranchID != "branch-child" {
	t.Fatalf("branch result = %+v", result)
}
if got := h.forker.LastTurnID(); got == nil || *got != "provider-turn-1" {
	t.Fatalf("fork anchor = %#v", got)
}
if h.forker.RollbackCalls() != 0 {
	t.Fatal("editing called rollback")
}
```

Assert the replacement receives original decoded `DeliveryContentJSON`; malformed legacy delivery JSON refuses the edit rather than silently dropping context; the first prompt calls driver `Start`, not `Fork`; busy and handoff failures leave source active.

- [ ] **Step 2: Run tests and confirm methods are absent**

```bash
cd backend
go test ./internal/service/chat -run 'EditMessage|ActivateBranch' -count=1
```

Expected: compile failure.

- [ ] **Step 3: Preserve launch configuration**

Add `startConfigs map[domain.SessionID]StartConfig` under the service mutex. Store a defensive copy after successful `Start`; remove it when the session is explicitly stopped.

- [ ] **Step 4: Add the controller quiescence boundary**

```go
func (c *Controller) BeginIdleBranchHandoff(ctx context.Context) error {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.handoff { return ErrControllerHandoff }
	if c.pendingTurnID != "" { return ErrTurnRunning }
	if _, err := c.store.NextQueuedTurn(ctx, c.conversation.ID); err == nil {
		return ErrTurnRunning
	} else if !errors.Is(err, domain.ErrNoQueuedTurn) {
		return fmt.Errorf("check queue before branch handoff: %w", err)
	}
	c.handoff = true
	c.handoffDrain = false
	return nil
}
```

This is the non-destructive sibling of the existing `BeginHandoff`: it refuses instead of draining or interrupting, and leaves `handoff` set after returning. That persistent fence makes Send, steer, rollback, compaction, queue drain, and a second branch request reject until the service either calls existing `AbortHandoff` or closes the source after a successful swap. Add a race test that attempts Send in the gap after provider fork and before branch activation.

- [ ] **Step 5: Implement atomic controller replacement**

Add:

```go
type EditMessageResult struct {
	SourceBranchID string
	ActiveBranchID string
	Turn           domain.ConversationTurn
}
```

For a later prompt: resolve `ConversationEditAnchor`; call `BeginIdleBranchHandoff`; fork through its previous provider turn; resume the returned provider thread with the stored config and same `WorkspacePath`; mint branch/generation IDs; build the replacement controller while it is not yet registered; transactionally insert and activate; atomically swap the service's controller/generation entry; start the replacement event loop; close the fenced source; send edited text with decoded original content. The service, not the browser, is authoritative for stored attachments/resources so an edit cannot accidentally omit a base64 image or resource binding.

For the first prompt: start a fresh provider conversation with stored config and `fork_after_sequence = 0`.

If create/resume/readiness fails, close the unopened replacement and call `AbortHandoff`, leaving the source registered and active. If persistence succeeds but the in-memory swap/start fails, run a compensating activation transaction back to the source branch/provider/generation before `AbortHandoff`; add a fault-injection test for this exact boundary. If send fails after a successful swap, keep the new branch active and return the send error.

- [ ] **Step 6: Implement branch activation**

`ActivateBranch` uses the same persistent idle-handoff fence and compensating transaction, resumes the selected branch's provider thread in the same worktree, atomically updates active branch/session/generation, starts the replacement, closes the source, and sends no message.

- [ ] **Step 7: Run service and race tests**

```bash
cd backend
go test ./internal/service/chat -run 'EditMessage|ActivateBranch|Fork|Rollback' -count=1
go test -race ./internal/service/chat -run 'EditMessage|ActivateBranch' -count=1
```

Expected: PASS with no races.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/service/chat/controller.go backend/internal/service/chat/service.go backend/internal/service/chat/history.go backend/internal/service/chat/history_test.go backend/internal/service/chat/controller_test.go backend/internal/storage/sqlite/store/conversation_store.go
git commit -m "feat(chat): branch when editing earlier prompts"
```

### Task 5: HTTP contract and generated clients

**Files:**
- Modify: `backend/internal/httpd/controllers/conversations.go`
- Modify: `backend/internal/httpd/controllers/dto.go`
- Modify: `backend/internal/httpd/controllers/conversation_history_test.go`
- Modify: `backend/internal/httpd/controllers/conversations_test.go`
- Modify: `backend/internal/httpd/apispec/specgen/build.go`
- Modify: `docs/superpowers/specs/2026-08-09-codex-style-prompt-editing-design.md`
- Regenerate: `backend/internal/httpd/apispec/openapi.yaml`
- Regenerate: `frontend/src/api/schema.ts`

**Interfaces:**
- Consumes: Task 4 service methods and Task 3 metadata.
- Produces: edit and branch-activation routes plus branch fields in snapshots.

- [ ] **Step 1: Add failing route tests**

```go
request := `{"text":"edited prompt","clientMessageId":"edit-1"}`
response := requestJSON(t, server, http.MethodPost,
	"/api/v1/sessions/ao-1/conversation/turns/turn-2/edit", request)
if response.Code != http.StatusAccepted {
	t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
}
assertJSONField(t, response.Body.Bytes(), "activeBranchId", "branch-child")
```

Cover blank text, missing turn, unsupported fork, busy conflict, provider refusal, and branch-not-found activation.

- [ ] **Step 2: Run tests and confirm routes are absent**

```bash
cd backend
go test ./internal/httpd/controllers -run 'EditConversation|ActivateConversationBranch' -count=1
```

Expected: 404 or compile failure.

- [ ] **Step 3: Add DTOs and handlers**

```go
type EditConversationMessageRequest struct {
	Text            string `json:"text"`
	ClientMessageID string `json:"clientMessageId,omitempty"`
}

type ConversationContentSummaryResponse struct {
	Type     string `json:"type"`
	MIMEType string `json:"mimeType,omitempty"`
	URI      string `json:"uri,omitempty"`
	Name     string `json:"name,omitempty"`
}

type EditConversationMessageResponse struct {
	SourceBranchID string           `json:"sourceBranchId"`
	ActiveBranchID string           `json:"activeBranchId"`
	TurnID         string           `json:"turnId,omitempty"`
	ProviderTurnID string           `json:"providerTurnId,omitempty"`
	State          domain.TurnState `json:"state,omitempty"`
}

type ActivateConversationBranchResponse struct {
	ActiveBranchID string `json:"activeBranchId"`
}
```

Register:
- `POST /sessions/{sessionId}/conversation/turns/{turnId}/edit`
- `POST /sessions/{sessionId}/conversation/branches/{branchId}/activate`

Use error codes `CHAT_EDIT_UNSUPPORTED`, `CHAT_EDIT_BUSY`, `CHAT_EDIT_TURN_INVALID`, and `CHAT_BRANCH_NOT_FOUND`.

Add `Content []ConversationContentSummaryResponse` and `EditAvailable bool` to `ConversationMessageResponse`. For human messages, decode `DeliveryContentJSON` and strip image data and embedded resource text; retain unknown durable content types as generic named chips so future skill/mention blocks are not lost. This gives the inline editor truthful, lightweight attachment chips while the service reuses the exact durable blocks on send. Legacy text-only messages return an empty list and remain editable; malformed stored JSON sets `editAvailable: false` and is never fabricated client-side. Update the design spec's HTTP-boundary paragraph to record this safer server-authoritative contract.

- [ ] **Step 4: Register operations and regenerate**

Add named DTOs to `schemaNames`, then run:

```bash
npm run api
```

- [ ] **Step 5: Verify HTTP/spec parity**

```bash
cd backend
go test ./internal/httpd/... -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/httpd/controllers/conversations.go backend/internal/httpd/controllers/dto.go backend/internal/httpd/controllers/conversation_history_test.go backend/internal/httpd/controllers/conversations_test.go backend/internal/httpd/apispec/specgen/build.go backend/internal/httpd/apispec/openapi.yaml frontend/src/api/schema.ts docs/superpowers/specs/2026-08-09-codex-style-prompt-editing-design.md
git commit -m "feat(api): expose conversation prompt branching"
```

### Task 6: Frontend branch model and mutations

**Files:**
- Modify: `frontend/src/renderer/types/conversation.ts`
- Modify: `frontend/src/renderer/hooks/useConversation.ts`
- Modify: `frontend/src/renderer/hooks/useConversation.test.tsx`
- Modify: `frontend/src/renderer/lib/chat-fixture.ts`
- Modify: `frontend/src/renderer/components/chat/SessionChatSurface.tsx`

**Interfaces:**
- Consumes: generated Task 5 schema.
- Produces: branch snapshot types, `commands.editMessage`, and `commands.activateBranch`.

- [ ] **Step 1: Add failing hook tests**

```tsx
await act(async () => {
	await result.current.editMessage("turn-2", "edited prompt");
});
expect(requests).toContainEqual({
	method: "POST",
	path: "/api/v1/sessions/ao-1/conversation/turns/turn-2/edit",
	body: expect.objectContaining({ text: "edited prompt" }),
});
expect(requests.some((request) => request.path.endsWith("/rollback"))).toBe(false);
```

- [ ] **Step 2: Run and confirm missing mutations**

```bash
cd frontend
npm test -- useConversation.test.tsx
```

Expected: compile failure.

- [ ] **Step 3: Add branch types and mapping**

```ts
export interface ConversationBranchPoint {
	turnId: string;
	position: number;
	total: number;
	previousBranchId?: string;
	nextBranchId?: string;
}
```

Add a `ConversationContentSummary` view type and `content: ConversationContentSummary[]` on human messages. Extend `ConversationSnapshot` with `activeBranchId?: string`, `branchedFromEarlierMessage?: boolean`, and `branchPoints: ConversationBranchPoint[]`. Map them in `toSnapshot`; newest live page owns these fields during page merging.

- [ ] **Step 4: Add mutations**

Return these command fields:

```ts
editMessage: (turnId: string, text: string) =>
	editMessage.mutateAsync({ turnId, text }),
editMessagePending: editMessage.isPending,
editMessageError: editMessage.error ? apiErrorMessage(editMessage.error) : undefined,
activateBranch: (branchId: string) => activateBranch.mutateAsync(branchId),
activateBranchPending: activateBranch.isPending,
activateBranchError: activateBranch.error ? apiErrorMessage(activateBranch.error) : undefined,
```

Both mutations use `onSettled: invalidate` because the branch may activate before its first send fails. Pass them through `SessionChatSurface`.

- [ ] **Step 5: Run tests/typecheck**

```bash
cd frontend
npm test -- useConversation.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/renderer/types/conversation.ts frontend/src/renderer/hooks/useConversation.ts frontend/src/renderer/hooks/useConversation.test.tsx frontend/src/renderer/lib/chat-fixture.ts frontend/src/renderer/components/chat/SessionChatSurface.tsx
git commit -m "feat(frontend): wire conversation branch commands"
```

### Task 7: Codex-style inline prompt editor

**Files:**
- Create: `frontend/src/renderer/components/chat/HumanMessageEditor.tsx`
- Create: `frontend/src/renderer/components/chat/HumanMessageEditor.test.tsx`
- Modify: `frontend/src/renderer/components/chat/ChatTimelineItems.tsx`
- Modify: `frontend/src/renderer/components/chat/ChatWorkspace.tsx`
- Modify: `frontend/src/renderer/components/chat/ChatWorkspace.test.tsx`

**Interfaces:**
- Consumes: dedicated edit command from Task 6.
- Produces: inline Codex visual interaction independent of rollback and the bottom composer.

- [ ] **Step 1: Write failing visual/keyboard tests**

```tsx
await user.click(screen.getByRole("button", { name: "Edit user message" }));
const editor = screen.getByRole("textbox", { name: "Edit message" });
expect(editor).toHaveValue(originalText);
expect(screen.getByLabelText("Message the agent")).toHaveValue("unsent composer draft");

await user.clear(editor);
await user.type(editor, "edited prompt");
fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
await waitFor(() => expect(onEdit).toHaveBeenCalledWith("turn-1", "edited prompt"));
expect(onRollback).not.toHaveBeenCalled();
```

Also test Escape, Ctrl+Enter, blank text, busy copy, and error retention.

- [ ] **Step 2: Run and confirm current rollback composition fails**

```bash
cd frontend
npm test -- HumanMessageEditor.test.tsx ChatWorkspace.test.tsx
```

Expected: failures because the PR says Save and calls rollback then send.

- [ ] **Step 3: Build the focused editor**

```ts
export interface HumanMessageEditorProps {
	text: string;
	content: ConversationContentSummary[];
	pending: boolean;
	busy: boolean;
	error?: string;
	onCancel: () => void;
	onSend: (text: string) => Promise<unknown> | void;
}
```

Render an auto-focused multiline textarea, preserved attachment/resource chips above its footer, X/Cancel, and primary `ArrowUp` Send matching the main composer. Image chips use a compact image icon plus MIME label rather than rehydrating base64 into every snapshot; resource chips use the durable name/URI. Reserve the resting action row's 18px height. Use focus-visible styling, native titles, and accessible labels.

- [ ] **Step 4: Replace rollback composition**

Delete `await onRollback(message.turnId); await onSend(text)`. Gate Edit from `message.editAvailable`, matching-turn `providerTurnId`, and `can(snapshot, "fork")`. While a turn runs, allow the editor to open but disable Send with `Stop the current turn before branching`.

- [ ] **Step 5: Run tests/typecheck**

```bash
cd frontend
npm test -- HumanMessageEditor.test.tsx ChatWorkspace.test.tsx ChatWorkspaceRollback.test.tsx
npm run typecheck
```

Expected: PASS; explicit rollback remains separate.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/renderer/components/chat/HumanMessageEditor.tsx frontend/src/renderer/components/chat/HumanMessageEditor.test.tsx frontend/src/renderer/components/chat/ChatTimelineItems.tsx frontend/src/renderer/components/chat/ChatWorkspace.tsx frontend/src/renderer/components/chat/ChatWorkspace.test.tsx
git commit -m "feat(chat): match Codex prompt editing visuals"
```

### Task 8: Branch navigation and continuation notice

**Files:**
- Create: `frontend/src/renderer/components/chat/ConversationBranchNavigator.tsx`
- Create: `frontend/src/renderer/components/chat/ConversationBranchNavigator.test.tsx`
- Modify: `frontend/src/renderer/components/chat/ChatTimelineItems.tsx`
- Modify: `frontend/src/renderer/components/chat/ChatWorkspace.tsx`
- Modify: `frontend/src/renderer/components/chat/ChatWorkspace.test.tsx`

**Interfaces:**
- Consumes: branch points and activation command.
- Produces: previous/next controls on the divergent message and truthful worktree copy.

- [ ] **Step 1: Add failing navigation tests**

```tsx
expect(screen.getByText("2 / 3")).toBeVisible();
await user.click(screen.getByRole("button", { name: "Previous conversation branch" }));
expect(onActivateBranch).toHaveBeenCalledWith("branch-previous");
```

Also test `total === 1`, pending controls, and visible activation errors.

- [ ] **Step 2: Run and confirm component is absent**

```bash
cd frontend
npm test -- ConversationBranchNavigator.test.tsx ChatWorkspace.test.tsx
```

Expected: compile failure.

- [ ] **Step 3: Implement navigator**

Render `ChevronLeft`, tabular `N / M`, and `ChevronRight` in the muted action row. Omit the unavailable edge action rather than wrapping.

- [ ] **Step 4: Attach navigation and notice**

Index branch points by turn ID and pass the point to `HumanMessage`. Above the composer render once for an active child branch:

```tsx
<p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
	<GitBranch aria-hidden="true" className="size-3 shrink-0" />
	Conversation branched; worktree files were left unchanged.
</p>
```

Do not reuse `RolledBackNotice`.

- [ ] **Step 5: Run tests/typecheck**

```bash
cd frontend
npm test -- ConversationBranchNavigator.test.tsx ChatWorkspace.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/renderer/components/chat/ConversationBranchNavigator.tsx frontend/src/renderer/components/chat/ConversationBranchNavigator.test.tsx frontend/src/renderer/components/chat/ChatTimelineItems.tsx frontend/src/renderer/components/chat/ChatWorkspace.tsx frontend/src/renderer/components/chat/ChatWorkspace.test.tsx
git commit -m "feat(chat): navigate edited conversation branches"
```

### Task 9: End-to-end and native verification

**Files:**
- Modify: `backend/e2e/chat_history_test.go`
- Create: `frontend/e2e/chat-branch-edit.spec.ts`
- Modify: `frontend/e2e/support/fake-bridge.ts`

**Interfaces:**
- Consumes: completed feature.
- Produces: regression proof and real Electron visual verification.

- [ ] **Step 1: Add branch-preservation e2e coverage**

The backend test sends A/B/C, edits B to B2, verifies active history A/B2/new answer, activates source, verifies original A/B/C answers, and asserts a file created after C still exists on both conversation branches. The frontend Playwright test verifies the inline editor, preserved attachment chip, branch counter, navigation, and no resting-row layout shift using the fake bridge.

- [ ] **Step 2: Run focused e2e**

```bash
cd backend
go test ./e2e -run ConversationBranchEdit -count=1
```

Expected: PASS.

- [ ] **Step 3: Run relevant suites**

```bash
cd backend
go test ./internal/adapters/chatdriver/codexappserver/... ./internal/service/chat/... ./internal/storage/sqlite/... ./internal/httpd/...
go test -race ./internal/service/chat/...
cd ../frontend
npm test -- ChatWorkspace.test.tsx HumanMessageEditor.test.tsx ConversationBranchNavigator.test.tsx useConversation.test.tsx
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 4: Verify generators and diff hygiene**

```bash
npm run sqlc
npm run api
git diff --check
git status --short
```

Expected: no generated drift beyond intentional e2e/spec changes; `git diff --check` exits 0.

- [ ] **Step 5: Exercise the native Electron app**

Use `ao-desktop-dev` in isolated mode. Verify Copy/Edit reveal without layout shift; main-composer draft survives cancel; first and middle prompt edits use the Codex visuals; Send is blocked while a turn runs; branch arrows restore both continuations; branch notice appears only on the child; dark/light themes and narrow panes stay legible. Do not commit transient screenshots.

- [ ] **Step 6: Commit regression coverage**

```bash
git add backend/e2e/chat_history_test.go frontend/e2e/chat-branch-edit.spec.ts frontend/e2e/support/fake-bridge.ts
git commit -m "test(chat): cover Codex-style prompt branches"
```

- [ ] **Step 7: Review branch state**

```bash
git log --oneline --decorate -12
git diff origin/ao/agent-orchestrator-162/human-message-edit...HEAD --stat
git status --short --branch
```

Expected: clean worktree, focused conventional commits, and no files outside conversation branching/editing scope.
