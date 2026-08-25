# Cursor Chat and Terminal Interface Handoff

## Goal

Allow a Desktop AO worker running Cursor to switch between AO's structured Chat UI and Cursor's native terminal UI while preserving the exact Cursor conversation, transcript, worktree, AO session, and controller ownership guarantees.

This feature must use the same daemon-owned interface-transition path as Claude Code and Codex. It must not introduce a Cursor-only endpoint, transition state machine, or Desktop component.

## Scope

The first release targets Desktop AO. The daemon API remains client-neutral, but no new Mobile or Cloud presentation work is included.

Included:

- Cursor Chat to Cursor TUI handoff.
- Cursor TUI to Cursor Chat handoff.
- Existing `drain` and `interrupt` policies.
- Exact provider-native conversation identity in both directions.
- ACP history replay before Chat activation.
- Existing rollback and restart-recovery behavior.
- Unit, session-manager, live-conformance, and Desktop capability-presentation coverage.

Excluded:

- Cross-agent switching to or from Cursor.
- Summary-based or fresh-session fallback when identity cannot be proven.
- Reconstruction of Chat history from terminal scrollback.
- Migration of an in-flight tool process.
- New Mobile or Cloud UI work.

## Architecture

Cursor opts into `ports.AgentInterfaceHandoff`, the same optional adapter capability implemented by Claude Code and Codex.

`cursor.Plugin.NativeConversationID` resolves identity from the controller that currently owns the session:

- TUI source: the `agentSessionId` captured by Cursor's `sessionStart` hook and accepted under the current runtime launch generation.
- Chat source: the persisted ACP `ProviderConversationID`.

The adapter never derives, translates, or fabricates an ID. A missing or stale TUI identity fails closed through the session manager's existing `ErrNativeConversationMissing` or `ErrNativeConversationUnverified` paths.

Cursor will not initially implement `AgentInterfaceHandoffHistoryProbe`. Unlike Claude Code, Cursor does not expose a documented, stable local transcript location that AO can inspect without parsing provider-owned state. A non-empty, launch-fenced ID is treated as a resume candidate; the authoritative `cursor-agent --resume` or ACP `session/load` operation proves it. Target failure invokes the existing rollback path.

No schema, route, migration, or generated API change is required. Once the adapter declares the capability, the existing interface-transition status route reports Cursor as supported and the current Desktop control exposes “Open Chat” or “Open Terminal UI.”

## Controller Transaction

### Chat to Terminal UI

1. Create the durable interface-transition row.
2. Fence Chat intake and queued dispatch synchronously.
3. Preflight the Cursor binary and build `cursor-agent --resume <providerConversationId>`.
4. Drain accepted work, or cancel it under the explicit interrupt policy.
5. Stop `cursor-agent acp` conclusively.
6. Compare-and-swap the session controller epoch from Chat to TUI using the same native ID.
7. Launch Cursor's native TUI with `--resume <same-id>`.
8. Accept the new launch's `sessionStart` hook only under the new runtime generation.
9. Complete the durable transition and reopen input.

### Terminal UI to Chat

1. Create the durable interface-transition row.
2. Gate terminal input before preflight and quiescence checks.
3. Require the current launch generation to have captured a non-empty Cursor session ID.
4. Preflight Cursor ACP compatibility and authentication.
5. Drain to a settled provider boundary, or send the explicit interrupt and allow the bounded transcript flush window.
6. Stop the native TUI conclusively.
7. Compare-and-swap the session controller epoch from TUI to Chat using the same native ID.
8. Start `cursor-agent acp` and invoke ACP `session/load <same-id>`.
9. Import the replayed events idempotently before starting live event consumption.
10. Activate Chat only after replay completes; then complete the durable transition and reopen intake.

ACP `session/resume` is insufficient for this direction because it restores model context without replaying history. Cursor handoff support therefore requires `LoadSession` and the existing `ChatCapabilityHistory` advertisement.

## Capability Admission

Static adapter capability is necessary but not sufficient for a successful operation. Runtime preflight must continue to validate:

- Cursor Agent meets AO's minimum supported version.
- Cursor authentication is available.
- The source session has a non-empty native ID and, for TUI, that ID belongs to the current launch generation.

After source shutdown, the target ACP handshake must advertise `session/load` and the resumed conversation must supply `ChatHistoryReader` replay. AO's generic ACP probe does not create a conversation and therefore cannot promise dynamic handshake capabilities during preflight; failure at this target-start boundary uses the existing rollback transaction.

If a future Cursor release removes load support or changes identity semantics, AO fails the transition without claiming continuity.

## Errors and Recovery

The implementation reuses existing typed transition failures:

- Missing hook identity: `NATIVE_SESSION_MISSING`.
- Stale launch identity: `NATIVE_SESSION_UNVERIFIED`.
- Missing ACP replay: `TARGET_HISTORY_UNAVAILABLE`.
- Unsettled replay: `TARGET_HISTORY_UNSETTLED`.
- Native resume/load rejection: `TARGET_RESUME_FAILED`.
- Uncertain source stop: `SOURCE_STOP_UNCERTAIN`, requiring daemon reconciliation.

Failures before source stop leave the source controller open. Failures after source stop invoke the existing rollback transaction. Old ACP events and TUI hooks remain fenced by controller/runtime generation, so two controllers can never own input concurrently.

No fallback may start a new Cursor conversation with a generated summary. That would violate the exact-continuity requirement.

## Code Changes

Expected production changes are intentionally small:

- `backend/internal/adapters/agent/cursor/cursor.go`
  - declare `ports.AgentInterfaceHandoff` conformance;
  - implement `NativeConversationID` using the existing normalized metadata keys.
- `backend/internal/session_manager/interface_transition.go`
  - if required, tighten target preflight so TUI to Chat requires history capability before source shutdown; keep the change provider-neutral.
- `backend/internal/adapters/chatdriver/cursoracp/live_test.go`
  - add an opt-in cross-surface conformance test proving both native resume directions and transcript continuity.
- Focused unit and session-manager tests beside the existing Cursor and interface-transition tests.

The Desktop renderer should require no production change. A focused presentation test may be updated only if current fixtures hard-code the supported harness list.

## Verification

### Unit and integration tests

- Cursor returns the hook-captured ID for TUI and provider ID for Chat.
- Cursor rejects empty identities and does not derive an ID from the AO session ID.
- A stale TUI identity from an older launch generation is rejected by the generic coordinator.
- Chat to TUI launches `cursor-agent --resume <same-id>`.
- TUI to Chat calls ACP `session/load <same-id>` and imports replay before activation.
- A resume-only ACP handshake fails before source shutdown when possible, otherwise rolls back deterministically.
- Load failure, unsettled history, target launch failure, and daemon restart preserve one-controller ownership.
- Existing Claude Code and Codex transition tests remain unchanged and passing.

### Opt-in live conformance

Against the user's installed Cursor Agent and account:

1. Start a native Cursor TUI, submit a unique continuity marker, and capture its hook session ID.
2. Stop the TUI and load the same ID through ACP; assert the marker appears exactly once in replay and a new Chat turn can reference it.
3. Stop ACP and resume the same ID through `cursor-agent --resume`; assert both earlier turns remain in the native TUI.
4. Repeat one interrupt transition to confirm the cancelled turn is not presented as complete.

The live test remains explicitly opt-in and is excluded from CI because it uses a local Cursor installation and account.

## Acceptance Criteria

- Desktop Cursor workers show the existing interface-switch action.
- Both directions preserve the same native Cursor ID.
- Completed transcript entries appear exactly once after TUI to Chat replay.
- No transition activates a target using ACP resume without history replay.
- Failure never silently creates a new conversation.
- The session ID, worktree, branch, PR ownership, lifecycle state, and durable message outbox remain unchanged.
- At most one controller accepts input at every point, including failure and daemon-restart windows.
