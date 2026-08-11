# Promote a Queued Turn to Steer

## Goal

Allow a user to select any human message that is already queued behind a running Chat turn and deliver that complete message into the running turn as guidance. After provider acceptance, the message appears once as an ordinary steer inside the active turn; it no longer appears in its former queue position. The relative order of every other queued message is unchanged.

## Scope

This feature applies only to Chat-mode sessions whose driver advertises steering. It works for any selected queued human turn, not only the queue head. Text and structured content are promoted together when the adapter can encode all of them. It does not emulate steering for adapters that lack a native steer operation, interrupt the running turn, reorder the remaining queue, or move daemon logic into the Electron frontend.

## User Experience

While a provider-acknowledged, steerable turn is running, each queued human message shows a **Steer now** action. Pressing it disables that message's action and shows progress without changing the rest of the queue.

On success, the queued bubble disappears from its old position and the same content appears as a steer within the running turn. The timeline contains one visible copy. On an ordinary refusal, the bubble remains queued and shows actionable text. If the provider does not support steering, the action is absent. If the active turn ends during the request, the message returns to its original queue position and can drain normally.

A queued message may contain text, images, resource links, or embedded resources. Promotion succeeds only if the adapter can encode every block. Unsupported content leaves the message queued and produces a typed refusal. The existing composer remains unchanged by this feature; this design covers promotion of already queued messages.

## Architecture

The daemon exposes `POST /api/v1/sessions/{sessionId}/conversation/turns/{turnId}/steer`. The controller delegates to a new `PromoteQueuedTurn` chat-service method. The frontend supplies only the selected AO turn id; the daemon reads the durable message and delivery content so a stale or malicious client cannot substitute different content.

The live chat controller owns the operation and holds its existing `sendMu` for the full reservation, provider call, and finalization sequence. This serializes promotion with send, queue drain, interrupt, handoff, and other provider mutations. The target passed to the adapter is the provider-acknowledged active turn id, preserving the existing `ChatSteerer` precondition that guidance must fail rather than land on a different turn.

The SQLite store adds nullable promotion metadata to `conversation_turns` through a new migration; existing migrations are not edited. The metadata records when a queued turn was reserved and, after success, the AO turn that absorbed it. Queue selection excludes reserved turns. Conversation snapshots exclude successfully promoted source turns while retaining their durable audit relationship.

## Promotion Lifecycle

1. Validate that the selected turn exists, belongs to the session conversation, is human-originated, and is still queued.
2. Verify that the driver implements `ChatSteerer` and that a provider-acknowledged active turn exists.
3. Atomically reserve the selected queued turn and load its authoritative text, origin, client message id, and structured delivery content. A conditional `queued AND promotion_started_at IS NULL` update prevents two clients from claiming it.
4. Decode and validate the stored structured content.
5. Call `ChatSteerer.Steer` with the complete `ChatUserMessage` and the acknowledged provider turn id.
6. If the provider refuses before accepting, clear the reservation. The turn remains queued with its immutable requested time, so its relative queue position is unchanged.
7. If the provider accepts, atomically insert the steer activity on the active AO turn and mark the source turn completed with its `promoted_to_turn_id`. The activity detail preserves text, origin, client message id, structured content, and source turn id. The source message remains durable but is hidden with its promoted source turn.

Promotion uses an activity for the visible destination because that is the current durable representation of guidance delivered into an in-flight turn. The renderer extends its existing steer presentation to display the structured content using the same attachment rendering rules as a human message.

## Crash Safety and Recovery

The reservation occurs before the provider call so queue drain cannot deliver the same content concurrently. A normal provider refusal clears the reservation before releasing `sendMu`.

If the daemon stops while a reservation exists, startup recovery must not put that message back into the automatic queue: the provider may have accepted the steer before the process died. Recovery settles the source turn as failed with a promotion-uncertain error and clears the reservation. The content remains visible and recoverable, but it is never automatically delivered twice. The UI describes the uncertain result and offers the existing/new-message path for an explicit user retry rather than silently guessing.

If the provider accepts but finalizing the durable destination fails, AO makes a best-effort transition of the source turn to the same failed/uncertain outcome before returning an error. This matches the existing principle that provider acceptance is authoritative while avoiding later queue drain.

## Adapter Content Handling

`ChatSteerer` already accepts `ChatUserMessage`, including `Content`. Each steering adapter must use the same provider-neutral conversion rules it uses for normal sends:

- Codex app-server builds `turn/steer.input` from text and supported image/resource content rather than constructing a text-only input.
- ACP builds its steering extension `prompt` through the existing `promptContent` converter, including the adapter's image and embedded-context capability checks.

An adapter must reject the whole steer before sending when any block is invalid or unsupported. Partial content delivery is not allowed.

## API Outcomes

The endpoint returns the active provider turn id, the durable steer activity id, and the promoted source turn id on success. It uses the existing API error envelope and request id behavior.

- `TURN_NOT_FOUND`: the supplied turn is absent or belongs to another conversation.
- `TURN_NOT_QUEUED`: the turn has already dispatched, settled, or been promoted.
- `CHAT_NO_ACTIVE_TURN`: no acknowledged running turn can receive it.
- `CHAT_STEER_UNSUPPORTED`: the session driver cannot steer.
- `CHAT_TURN_NOT_STEERABLE`: a running provider turn cannot accept guidance.
- `CHAT_UNSUPPORTED_STEER_CONTENT`: the driver cannot encode the complete stored content.
- `CHAT_PROMOTION_UNCERTAIN`: provider delivery may have occurred but AO cannot safely confirm the durable transition.

Retries after a successful promotion return `TURN_NOT_QUEUED`; frontend query invalidation removes the old action. During an in-flight request, a second claimant receives a conflict and does not contact the provider.

## Frontend Data Flow

`SessionChatSurface` exposes a promotion command from `useConversation`. `ChatWorkspace` passes it only when the snapshot advertises steer capability and contains a running turn. The timeline passes the queued AO turn id to `HumanMessage`, which renders **Steer now** only for queued human messages.

Pending and refusal state is keyed by source turn id so promoting one queue item does not disable unrelated items. On success, the conversation query is invalidated; the durable steer activity appears in the active group and the promoted source turn disappears. The client does not optimistically move content because the provider is the authority on acceptance.

## Testing

Backend service tests cover promoting the queue head and a later queued item, preserving remaining order, provider refusal restoration, no active turn, unsupported driver, wrong-session/unknown/non-queued turns, concurrent claims, structured-content delivery, finalization failure, and crash recovery that prevents automatic redelivery.

SQLite store tests cover conditional reservation, reserved-turn exclusion from queue selection, release preserving requested order, atomic finalization, snapshot hiding of promoted source turns, and recovery of abandoned reservations.

Adapter tests assert Codex and ACP wire payloads contain all supported content blocks and reject unsupported blocks before sending anything. Controller tests cover the new route, response DTO, typed error mapping, and OpenAPI parity. Generated OpenAPI and frontend schema artifacts are regenerated together.

Frontend tests cover action visibility, selection of a non-head queued item, per-turn pending state, refusal keeping the message queued, success invalidation, destination steer rendering with attachments, and absence of the action when no acknowledged running turn or steer capability exists.

Verification runs narrow backend and frontend tests first, then Go tests for the affected packages, API regeneration drift checks, frontend typecheck, and frontend build. The running AO desktop app is restarted and the flow is demonstrated in its Browser panel as required by repository guidance.
