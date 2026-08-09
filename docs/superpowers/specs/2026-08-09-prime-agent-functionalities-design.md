# Prime Agent Functionalities

## Problem

AO can launch Prime Agent and already passes an optional model and AO-generated
system prompt, but the integration is intentionally ephemeral. It launches with
`--no-session`, does not capture Prime's native session ID, reports native
restore as unavailable, and falls back to a free-text model field. Consequently,
terminated Prime Agent sessions cannot resume their conversation history and
the model picker cannot discover the models available in the user's Prime
configuration.

Removing `--no-session` by itself is unsafe. Normal interactive Prime sessions
run in resident workers: closing the terminal client detaches it instead of
stopping the worker. AO must not remove a session worktree while a detached
Prime worker can still operate in it.

## Goals

- Preserve the existing worker and orchestrator system-prompt generation.
- Pass the effective AO role prompt to Prime with
  `--append-system-prompt <text>` on fresh launch and native restore.
- Discover selectable Prime models with `prime-agent model list` and normalize
  them as `provider/model` IDs.
- Save Prime transcripts under AO's data directory and capture their native
  session IDs through the managed extension.
- Restore a terminated Prime session with `prime-agent --resume <session-id>`.
- Stop a matching resident Prime worker before AO removes its worktree, while
  retaining the transcript for later resume.
- Deliver the complete integration in one branch and pull request.

## Non-goals

- Adding a Prime-specific provider or thinking-level setting. Prime accepts a
  provider-qualified value in the existing model field, including optional
  thinking syntax supported by the CLI.
- Changing AO's project configuration, session metadata schema, HTTP API, or
  generated frontend API types.
- Managing unrelated Prime sessions or shutting down Prime's global daemon.
- Replacing Prime's built-in system prompt. AO appends role instructions so
  Prime retains its native prompt and extension/resource context.

## Design

### Session-owned paths

The adapter derives two stable paths from `LaunchConfig.DataDir` and
`RestoreConfig.DataDir`:

```text
<AO_DATA_DIR>/agent-runtime/prime-agent/ao-activity.ts
<AO_DATA_DIR>/agent-runtime/prime-agent/sessions/
```

The existing extension path remains unchanged. Fresh launch and restore both
pass the sessions path through `--session-dir`, preventing AO-managed
transcripts from being mixed with the user's ordinary Prime sessions.

### Fresh launch and system prompts

Fresh launch removes `--no-session` and builds this command:

```text
prime-agent
  --session-dir <AO Prime sessions directory>
  --extension <AO managed extension>
  [--append-system-prompt <effective role prompt>]
  [--model <effective role model>]
  [-- <initial task>]
```

Session Manager remains the source of truth for prompt content. It builds a
coordination-only prompt for orchestrators and an implementation prompt for
workers, including the current project rules and active orchestrator identity.
The adapter continues resolving an inline system prompt before falling back to
the AO-owned prompt file. Blank prompt content omits the flag.

`--append-system-prompt` is used rather than `--system-prompt`: the append flag
is part of Prime's public CLI and preserves Prime's built-in instructions.

### Native session identity

On `session_start`, the managed Prime extension reports:

```ts
{
  reason: event.reason ?? "",
  session_id: context.sessionManager.getSessionId(),
}
```

The existing `ao hooks` pipeline already extracts `session_id` for registered
harnesses and persists it as `SessionMetadata.AgentSessionID`. No new database
column or API field is required.

### Restore

`GetRestoreCommand` reads
`cfg.Session.Metadata[ports.MetadataKeyAgentSessionID]`. A non-blank ID produces:

```text
prime-agent
  --session-dir <AO Prime sessions directory>
  --extension <AO managed extension>
  [--append-system-prompt <effective role prompt>]
  [--model <effective role model>]
  --resume <native session ID>
```

The stored task is not replayed during native resume because it is already in
the Prime transcript. Prime handles both native states: it reopens an inactive
JSONL transcript or attaches to the resident worker that already owns it.

When the native ID is blank, `GetRestoreCommand` returns `ok=false`. Existing
Session Manager behavior remains unchanged: workers with a saved task get a new
conversation from that task, orchestrators get a fresh promptless launch, and a
promptless worker remains not resumable.

### Resident-worker termination

Add a narrow optional agent capability for stopping a native session before
runtime/workspace teardown. Session Manager invokes it only for adapters that
implement it and only for teardown paths that can remove or retire the
worktree. Existing adapters remain unchanged.

Prime's implementation performs bounded local CLI operations:

1. Run `prime-agent list --json`.
2. Find the single live entry whose transcript `sessionId` matches AO's stored
   `AgentSessionID`.
3. If found, run `prime-agent stop <activeSessionId> --json`.
4. If no live entry matches, return success because the transcript is already
   inactive and resumable.

AO never calls `prime-agent shutdown`, never stops an unmatched session, and
never treats an ambiguous match as safe. Stop failure prevents destructive
worktree teardown in user-directed termination paths. Bulk shutdown retains its
existing per-session error isolation: it logs the failure and leaves that
session's worktree intact.

The capability is invoked before Prime's terminal runtime is destroyed so the
CLI can still use the session's valid working directory. It covers explicit
kill, orchestrator replacement, graceful save-and-teardown, and boot
reconciliation before a worktree is removed. Runtime destruction that occurs
only as launch rollback and has no captured native ID remains a no-op.

### Automatic model discovery

Register Prime in the existing command-backed catalog:

```text
prime-agent model list
```

Prime emits the same provider/model table shape already parsed for Pi and
Kimchi. Reuse `parsePiModels` to produce entries with:

- `ID`: `provider/model`
- `Label`: model ID
- `Provider`: provider name

The model picker remains searchable and allows a custom value. Existing catalog
timeouts, cache behavior, binary resolution, and manual fallback apply without
special cases.

## Data Flow

1. Session Manager computes the role-specific system prompt and effective
   role-specific model.
2. Prime launches persistently in AO's Prime session directory.
3. The extension reports Prime's native session ID; lifecycle persistence stores
   it on the AO session.
4. Before destructive teardown, AO stops any live Prime resident worker matched
   to that native ID and preserves the JSONL transcript.
5. Restore recreates the worktree and terminal, recomputes the current role
   prompt/model, and asks the adapter for its restore command.
6. Prime resumes the stored transcript and the extension reports the same native
   identity again.

## Error Handling

- Missing or blank `DataDir` remains an adapter configuration error.
- A missing system-prompt file returns a wrapped filesystem error before launch.
- A blank native session ID reports native restore as unavailable instead of
  constructing an interactive resume picker.
- Model discovery failures use the existing warning and manual-entry fallback.
- Malformed Prime model-list rows are ignored; an empty normalized result is a
  discovery error.
- Malformed `prime-agent list --json`, ambiguous live matches, or a failed
  `prime-agent stop` are explicit errors and do not authorize worktree removal.
- Context cancellation is checked before filesystem reads and CLI operations.

## Testing

Adapter tests will verify:

- fresh launch includes the AO session directory, managed extension, appended
  prompt, role-selected model, and protected initial task in stable order;
- inline and file-backed system prompts work on launch and restore;
- restore uses the stored native ID and never replays the original task;
- missing native IDs return `ok=false`;
- the extension reports `session_id` from Prime's session manager;
- resident-worker lookup stops only the exactly matched active session and is a
  no-op when the transcript is not live;
- malformed, ambiguous, failed, and canceled stop operations are safe.

Model-catalog tests will verify Prime's documented command and provider-qualified
normalization. Session Manager tests will verify the optional stop capability is
called before runtime/workspace teardown, that unsupported adapters are
unchanged, and that stop failure preserves the worktree.

Verification runs the focused Prime adapter, model-catalog, Session Manager, and
hook tests first, followed by backend `go test ./...`, repository lint, and
frontend typecheck because the model picker consumes the normalized catalog.

