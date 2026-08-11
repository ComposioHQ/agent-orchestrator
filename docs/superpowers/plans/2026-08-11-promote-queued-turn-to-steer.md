# Promote Queued Turn to Steer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user promote any already queued Chat message into the provider-acknowledged running turn without duplicate delivery, including all adapter-supported structured content.

**Architecture:** The chat controller reserves the selected queued turn durably while holding `sendMu`, calls the existing `ChatSteerer`, and then atomically records the destination steer plus the source-turn promotion link. Queue selection ignores reservations, successful source turns are hidden from snapshots, and abandoned reservations settle as uncertain instead of being automatically delivered twice.

**Tech Stack:** Go, SQLite/sqlc/goose, chi/OpenAPI generation, React 19, TanStack Query, TypeScript, Vitest.

## Global Constraints

- Keep the CLI and Electron frontend thin; promotion authority remains in the daemon chat service.
- Do not edit existing SQLite migrations or generated sqlc files by hand.
- Preserve trigger-based CDC and regenerate sqlc/OpenAPI/frontend schema artifacts.
- The selected queued message is authoritative from storage; the client sends only its turn id.
- Any selected queued item may be promoted and all remaining queue order is preserved.
- Reserve before provider delivery; never automatically redeliver an uncertain promotion.
- Provider refusal restores the original queued item and queue order.
- Deliver text and every structured block together or reject the whole promotion.

---

### Task 1: Durable queue-promotion lifecycle

**Files:**
- Create: `backend/internal/storage/sqlite/migrations/0086_conversation_turn_promotion.sql`
- Modify: `backend/internal/storage/sqlite/queries/conversations.sql`
- Modify: `backend/internal/domain/conversation.go`
- Modify: `backend/internal/storage/sqlite/store/conversation_store.go`
- Test: `backend/internal/storage/sqlite/store/conversation_history_store_test.go`
- Generate: `backend/internal/storage/sqlite/gen/*`

**Interfaces:**
- Produces: `ReserveQueuedTurnForPromotion(ctx, conversationID, turnID string, now time.Time) (domain.QueuedTurn, error)`.
- Produces: `ReleaseQueuedTurnPromotion(ctx, conversationID, turnID string) error`.
- Produces: `CompleteQueuedTurnPromotion(ctx, conversationID, sourceTurnID, providerTurnID string, activity domain.ConversationActivity, now time.Time) error`.
- Produces typed sentinels for not-found, not-queued, and already-reserved outcomes.

- [ ] **Step 1: Write failing store tests**

Add tests that append a running turn plus three queued messages and assert:

```go
selected, err := s.ReserveQueuedTurnForPromotion(ctx, conversation, "queued-2", now)
if err != nil { t.Fatal(err) }
if selected.Text != "second queued" { t.Fatalf("text = %q", selected.Text) }
next, err := s.NextQueuedTurn(ctx, conversation)
if err != nil { t.Fatal(err) }
if next.TurnID != "queued-1" { t.Fatalf("queue head = %q", next.TurnID) }
```

Also assert a second reservation conflicts, release makes the same item eligible at its original order, completion records one steer activity on the provider turn, successful source turns do not appear in snapshots, and orphan reconciliation settles reserved turns failed rather than making them queue-eligible.

- [ ] **Step 2: Run the store tests and verify RED**

Run: `cd backend && go test ./internal/storage/sqlite/store -run 'Promotion|QueuedTurn'`

Expected: compile failure because the reservation/finalization methods do not exist.

- [ ] **Step 3: Add migration and SQL queries**

Add nullable `promotion_started_at` and `promoted_to_turn_id` columns, with the latter referencing `conversation_turns(id)`. Add conditional reserve/release queries, make `SelectNextQueuedConversationTurn` require `promotion_started_at IS NULL`, and exclude `promoted_to_turn_id IS NOT NULL` from snapshot turn queries. Add an orphan-reconciliation update for reserved turns.

- [ ] **Step 4: Implement transactional store methods and regenerate sqlc**

Use `writeMu` and a SQL transaction for completion. The transaction must resolve the active AO turn by `(conversation_id, provider_turn_id)`, insert/upsert the supplied activity through the transaction query set, and mark the source `completed`, `completed_at`, and `promoted_to_turn_id` together.

Run: `npm run sqlc`

- [ ] **Step 5: Run store tests and verify GREEN**

Run: `cd backend && go test ./internal/storage/sqlite/store -run 'Promotion|QueuedTurn'`

Expected: PASS.

- [ ] **Step 6: Commit the storage slice**

```bash
git add backend/internal/domain backend/internal/storage/sqlite
git commit -m "feat(chat): persist queued turn promotion"
```

### Task 2: Chat service promotion command

**Files:**
- Modify: `backend/internal/service/chat/controller.go`
- Modify: `backend/internal/service/chat/service.go`
- Modify: `backend/internal/service/chat/steer.go`
- Test: `backend/internal/service/chat/steer_test.go`

**Interfaces:**
- Produces: `PromoteQueuedTurn(ctx context.Context, session domain.SessionID, turnID string) (PromoteQueuedTurnResult, error)`.
- `PromoteQueuedTurnResult` contains `SourceTurnID`, `ProviderTurnID`, and `ActivityID`.
- Consumes Task 1 reservation, release, and completion store methods.

- [ ] **Step 1: Write failing service tests**

Add a test that starts and acknowledges one provider turn, queues three messages, and promotes the middle id:

```go
result, err := h.svc.PromoteQueuedTurn(ctx, testSession, middle.ID)
if err != nil { t.Fatal(err) }
if result.SourceTurnID != middle.ID { t.Fatalf("source = %q", result.SourceTurnID) }
calls := provider.steers()
if len(calls) != 1 || calls[0].msg.Text != "second queued" { t.Fatalf("steers = %+v", calls) }
```

Assert the remaining queue drains first then third, the snapshot has one destination steer and no visible source turn, stored `Content` reaches the provider, and provider refusal restores the selected turn. Add typed tests for absent, foreign, non-queued, unsupported, no-active-turn, and already-reserved selections.

- [ ] **Step 2: Run service tests and verify RED**

Run: `cd backend && go test ./internal/service/chat -run 'PromoteQueued'`

Expected: compile failure because `PromoteQueuedTurn` is missing.

- [ ] **Step 3: Implement controller orchestration**

Under `sendMu`, verify `ChatSteerer`, await the acknowledged provider turn, reserve/load the queued message, decode `DeliveryContentJSON`, and call `steerer.Steer`. On ordinary refusal release the reservation before mapping the existing typed steer error. On success build a steer activity detail containing:

```json
{"event":"steer","text":"...","origin":"human","clientMessageId":"...","sourceTurnId":"...","content":[]}
```

Finalize through the Task 1 transaction. If acceptance succeeded but finalization fails, settle the reserved source as an uncertain failure and return `ErrPromotionUncertain`.

- [ ] **Step 4: Run service tests and verify GREEN**

Run: `cd backend && go test ./internal/service/chat -run 'Steer|PromoteQueued'`

Expected: PASS.

- [ ] **Step 5: Commit the service slice**

```bash
git add backend/internal/service/chat
git commit -m "feat(chat): promote queued messages into active turns"
```

### Task 3: Structured steering in Codex and ACP adapters

**Files:**
- Modify: `backend/internal/adapters/chatdriver/codexappserver/steer.go`
- Modify: `backend/internal/adapters/chatdriver/codexappserver/conversation.go`
- Test: `backend/internal/adapters/chatdriver/codexappserver/steer_test.go`
- Modify: `backend/internal/adapters/chatdriver/acp/steer.go`
- Test: `backend/internal/adapters/chatdriver/acp/driver_test.go`

**Interfaces:**
- Consumes: `ports.ChatUserMessage{Text, Content}`.
- Produces: a complete provider prompt or a preflight error before any steering request is sent.

- [ ] **Step 1: Write failing adapter payload tests**

For Codex assert `turn/steer.input` contains text plus a local/native image input for supported content. For ACP assert the `_session/steering` prompt is built by `promptContent` and contains text, image, resource-link, and embedded-resource blocks permitted by capabilities. Assert invalid or unsupported blocks produce no provider request.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `cd backend && go test ./internal/adapters/chatdriver/codexappserver ./internal/adapters/chatdriver/acp -run 'Steer.*Content|Steer.*Attachment'`

Expected: assertions fail because both steer implementations currently emit text only.

- [ ] **Step 3: Reuse provider content conversion**

Extract a focused Codex input builder used by steer (and normal send where compatible). Replace ACP's hard-coded `[]acpsdk.ContentBlock{acpsdk.TextBlock(msg.Text)}` with `c.promptContent(msg)`. Keep the all-or-nothing validation before the request.

- [ ] **Step 4: Run adapter tests and verify GREEN**

Run: `cd backend && go test ./internal/adapters/chatdriver/codexappserver ./internal/adapters/chatdriver/acp -run 'Steer'`

Expected: PASS.

- [ ] **Step 5: Commit the adapter slice**

```bash
git add backend/internal/adapters/chatdriver
git commit -m "feat(chat): steer structured message content"
```

### Task 4: HTTP and generated API contract

**Files:**
- Modify: `backend/internal/httpd/controllers/conversations.go`
- Modify: `backend/internal/httpd/controllers/conversation_steer.go`
- Modify: `backend/internal/httpd/controllers/conversations_test.go`
- Modify: `backend/internal/httpd/apispec/specgen/build.go`
- Generate: `backend/internal/httpd/apispec/openapi.yaml`
- Generate: `frontend/src/api/schema.ts`

**Interfaces:**
- Route: `POST /api/v1/sessions/{sessionId}/conversation/turns/{turnId}/steer`.
- Success: HTTP 202 with `{sourceTurnId, providerTurnId, activityId}`.

- [ ] **Step 1: Write failing controller tests**

Register the route in the test router and assert it passes both path ids to the fake service, returns the response ids, and maps each Task 2 sentinel to the specified API code without losing the request id envelope.

- [ ] **Step 2: Run controller tests and verify RED**

Run: `cd backend && go test ./internal/httpd/controllers -run 'PromoteQueued|Queued.*Steer'`

Expected: 404 or compile failure because the route/service method is missing.

- [ ] **Step 3: Implement route, DTO, error mapping, and spec registration**

Add the method to `ConversationService`, register the turn-scoped route next to rollback, create the response DTO in `conversation_steer.go`, and add the operation/schema names to spec generation.

- [ ] **Step 4: Regenerate and verify API artifacts**

Run: `npm run api`

Run: `cd backend && go test ./internal/httpd/...`

Expected: PASS with route/spec parity and generated schema in sync.

- [ ] **Step 5: Commit the API slice**

```bash
git add backend/internal/httpd frontend/src/api/schema.ts
git commit -m "feat(api): expose queued turn promotion"
```

### Task 5: Queued-message action and destination rendering

**Files:**
- Modify: `frontend/src/renderer/hooks/useConversation.ts`
- Modify: `frontend/src/renderer/components/chat/SessionChatSurface.tsx`
- Modify: `frontend/src/renderer/components/chat/ChatWorkspace.tsx`
- Modify: `frontend/src/renderer/components/chat/ChatTimelineItems.tsx`
- Modify: `frontend/src/renderer/types/conversation.ts`
- Test: `frontend/src/renderer/components/chat/ChatSteer.test.tsx`
- Test: `frontend/src/renderer/hooks/useConversation.test.tsx`

**Interfaces:**
- Produces: `promoteQueuedTurn(turnId: string): Promise<unknown>` plus `promotingTurnId` and per-turn refusal state.
- `HumanMessage` receives optional `onSteerNow`, `steering`, and `steerRefusal` props only for queued human messages.

- [ ] **Step 1: Write failing UI tests**

Construct a snapshot with one running and at least two queued turns. Assert every queued human bubble has a **Steer now** button, clicking the second calls `onPromoteQueuedTurn(secondTurnId)`, only that button becomes pending, refusal retains the queued bubble, and no actions render without a running turn/capability. Extend the steer fixture detail with structured content and assert the destination renders its attachment once.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `cd frontend && npm test -- --run src/renderer/components/chat/ChatSteer.test.tsx src/renderer/hooks/useConversation.test.tsx`

Expected: missing action/mutation assertions fail.

- [ ] **Step 3: Implement the mutation and prop flow**

Call the generated turn-scoped endpoint from `useConversation`, invalidate conversation queries on success, and keep pending/refusal state keyed by turn id. Pass the action through `SessionChatSurface`, `ChatWorkspace`, `Timeline`, `TurnGroup`, and `TimelineItem` to `HumanMessage`. Gate it on an actually running turn and advertised steer capability.

- [ ] **Step 4: Render structured steer content**

Extend steer-detail parsing to expose `content` and render supported attachments with the same safe URL/name helpers used by human messages. Keep one visible destination item and no optimistic source movement.

- [ ] **Step 5: Run UI tests and verify GREEN**

Run: `cd frontend && npm test -- --run src/renderer/components/chat/ChatSteer.test.tsx src/renderer/hooks/useConversation.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the frontend slice**

```bash
git add frontend/src/renderer
git commit -m "feat(chat-ui): steer queued messages into active turn"
```

### Task 6: Verification and desktop demonstration

**Files:**
- Modify only files required by failures attributable to this feature.

- [ ] **Step 1: Run focused backend verification**

Run: `cd backend && go test ./internal/storage/sqlite/store ./internal/service/chat ./internal/adapters/chatdriver/codexappserver ./internal/adapters/chatdriver/acp ./internal/httpd/...`

Expected: PASS.

- [ ] **Step 2: Run frontend verification**

Run: `cd frontend && npm run typecheck && npm run build`

Expected: PASS.

- [ ] **Step 3: Run repository checks proportional to the change**

Run: `npm run lint`

Expected: PASS, or report pre-existing unrelated failures with exact evidence.

- [ ] **Step 4: Restart the AO desktop app and demonstrate**

Use the repository's `ao-desktop-dev` skill to restart the current checkout. In a steer-capable Chat session, start a long turn, queue two messages, promote the second, and verify it appears inside the active turn while the first remains queued. Repeat with an attachment supported by the active adapter. Run `ao preview [url]` inside the session if a frontend preview target is involved.

- [ ] **Step 5: Inspect the final diff and status**

Run: `git diff --check && git status --short && git log --oneline -8`

Expected: no whitespace errors, only scoped changes, and all generated artifacts committed with their sources.
