# Codex-Style Prompt Editing

Status: approved interaction direction for PR #3676

## Summary

AO will match Codex's prompt-editing interaction and semantics. A human message exposes Copy and Edit actions on hover or keyboard focus. Edit opens an inline editor in the message bubble. Sending the edited prompt creates a new conversation branch immediately before that prompt, preserves the original conversation, and continues on the new branch in the same worktree. It does not roll back or revert files.

This replaces PR #3676's current `rollback -> send` implementation. That implementation looks like editing but destructively removes the selected turn and all later turns from the active provider history.

## User Experience

### Resting message

- Human messages remain right-aligned and use the existing chat bubble tokens.
- Hovering the bubble, or focusing within its action row, reveals icon-only Copy and Edit controls below the bubble.
- Both controls use the same size, muted color, hover background, focus treatment, and native tooltip as Codex-style message actions.
- The action row reserves its height so messages do not jump when controls appear.
- Edit is offered only for human messages backed by a provider-accepted turn and only when the driver advertises conversation forking.

### Inline editing

- Clicking Edit replaces the bubble body with an inline multiline editor; it does not move the text to the bottom composer.
- The editor is one wide, rounded composer surface using the same border, background, spacing, transparent textarea, and focus treatment as the main Codex-style message input. It must not render a second bordered textarea inside that surface.
- The editor starts with the exact original structured prompt: text, attachments, images, skills, and mention bindings when those inputs are durably available.
- The existing bottom composer and any unsent draft remain untouched.
- The editor uses the conversation's readable width, grows with content up to a bounded height, and then scrolls internally.
- Escape cancels. Command/Ctrl+Enter sends. Enter inserts a newline.
- The footer keeps the existing icon-only Cancel and Send controls unchanged. It does not say Save because no existing message is mutated.

### Sending and branch navigation

- Sending forks immediately before the selected prompt, then submits the edited prompt as the first turn on the new branch.
- Editing the first prompt starts a fresh provider conversation in the same session and worktree because there is no earlier turn to fork through.
- The source branch remains durable and provider-visible.
- After the fork succeeds, AO switches the session to the new branch and shows a quiet continuation notice: `Branched from an earlier message`.
- When a message position has multiple continuations, compact previous/next chevrons and an `N / M` counter appear beneath the message. Switching branches resumes the selected provider thread and redraws only that branch's timeline.
- Files already changed in the worktree are not reverted. The first branch notice states `Conversation branched; worktree files were left unchanged` so the transcript and filesystem contract are explicit.

### Busy and failure states

- AO never runs two branches against one worktree concurrently.
- While a turn is active, Copy remains available. Edit may open so the user can prepare text, but Send is disabled and the editor says `Stop the current turn before branching`. The existing interrupt action remains the way to stop it.
- If provider branching or controller handoff fails, the original branch stays active, the inline editor remains open, and the exact draft is restored with an actionable error.
- If the branch is created but sending the edited prompt fails, the new branch remains active with an empty continuation and the draft remains available for retry. AO does not silently return to or mutate the original branch.
- Drivers without fork support do not render Edit.

## Architecture

### Provider boundary

Replace the whole-history-only fork boundary with a targeted operation that accepts the last provider turn to retain:

```go
type ChatForker interface {
    Fork(ctx context.Context, lastProviderTurnID *string) (providerConversationID string, error error)
}
```

For Codex this maps to `thread/fork { threadId, lastTurnId }`. The service resolves the provider turn immediately before the edited AO turn. The first prompt uses the driver's ordinary new-conversation path rather than a fork with an invented anchor.

The source controller remains authoritative until the new provider conversation is created, resumed on the same worktree, and ready. Only then does AO switch the session's active branch and close the old controller.

### Durable branch model

Add a new SQLite migration; do not modify an existing migration.

`conversation_branches` records:

- branch ID;
- AO session ID;
- provider conversation ID;
- parent branch ID;
- AO turn ID and provider turn ID at the fork point;
- creation time.

The existing conversation gains an active branch reference. Conversation turns, items, approvals, and other branch-owned facts gain a branch reference. Existing rows migrate to one root branch per conversation.

Snapshot reads return the active branch's ancestry through each fork point plus that branch's own continuation. Sibling branches remain durable and can be selected without marking any turn rolled back. Rollback remains a separate explicit history action and continues to use `rolled_back_at`; editing never writes that field.

Changing the active branch and provider conversation ID is transactional after the target controller is ready. On daemon restart, the session resumes the active branch's provider conversation.

### Structured prompt preservation

AO persists the structured human input needed to reconstruct attachments and mention bindings. The edit request carries only replacement display text and an idempotency key; the service reuses the exact durable blocks, so a browser cannot accidentally omit an image or resource binding. Legacy text-only messages remain editable. Malformed legacy structured content is marked unavailable rather than fabricated.

### HTTP and frontend boundary

Add a code-first endpoint under the conversation controller for editing/forking a turn. Snapshot messages expose lightweight content summaries with image bytes and embedded resource text stripped, plus an explicit edit-availability flag. The edit response identifies the active branch and new turn. Regenerate OpenAPI and frontend schema artifacts together.

The frontend calls one edit operation rather than composing `rollback` and `send`. `ChatWorkspace` owns which message is being edited; `HumanMessage` owns only the inline presentation and draft interaction. Session command hooks own the mutation, pending state, and error envelope.

## Testing

### Backend

- Codex driver sends `thread/fork` with the previous provider turn ID.
- Editing the first prompt starts a fresh provider conversation.
- The original provider thread is never rolled back or deleted.
- The fork inherits the source worktree and session configuration.
- Branch creation, controller handoff, active-branch persistence, restart, and branch switching are covered.
- Branch creation and handoff failures leave the original branch active.
- Busy sessions receive a conflict without changing either branch.
- Structured text, image/file attachments, skills, and mentions survive editing when their metadata exists.
- API route/spec parity and generated frontend schema stay in sync.

### Frontend

- Copy and Edit appear on hover and keyboard focus without layout shift.
- Edit opens inline with exact content and does not overwrite the main composer draft.
- Escape cancels; Command/Ctrl+Enter sends; blank prompts cannot send.
- Send uses the fork-and-edit command and never calls rollback.
- Busy, pending, failure, unsupported-driver, and retry states render correctly.
- Branch chevrons switch between the original and edited continuations.
- Light theme, dark theme, narrow center pane, long prompt, and keyboard-only use receive visual coverage.

### Native verification

Run the focused frontend and backend tests, typecheck, API drift tests, and then exercise the flow in the real Electron app using isolated AO data. Verify editing a first prompt, editing a middle prompt, switching back to the original branch, preserving an existing composer draft, and handling a running turn.

## Non-goals

- Editing assistant messages.
- Reverting, resetting, or copying worktree files when a conversation branches.
- Running two branches concurrently in the same worktree.
- Exposing Edit for providers that cannot fork conversations.
- Replacing the existing explicit rollback/undo action.
