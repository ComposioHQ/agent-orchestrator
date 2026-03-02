# PRD: OpenCode SDK-Only Parity

## Objective

Migrate `agent-opencode` from CLI/tmux-driven orchestration to SDK-driven orchestration and reach parity with Claude/Codex lifecycle behavior in this repo.

## Current Baseline (verified on `main`)

- `agent-opencode` currently launches shell command (`opencode` / `opencode run ...`) in `packages/plugins/agent-opencode/src/index.ts`.
- `getActivityState()` returns `null` while running and only reports `exited` when process stops in `packages/plugins/agent-opencode/src/index.ts`.
- `getSessionInfo()` always returns `null` in `packages/plugins/agent-opencode/src/index.ts`.
- `sessionManager.spawn()` builds `launchCommand` from `agent.getLaunchCommand()` and runtime create in `packages/core/src/session-manager.ts`.
- `web /api/sessions/[id]/message` bypasses `sessionManager.send()` and calls runtime `sendMessage()` directly in `packages/web/src/app/api/sessions/[id]/message/route.ts`.

## Product Decision (locked)

- OpenCode orchestration path is SDK-only.
- No CLI fallback mode for OpenCode session lifecycle.
- Web terminal must attach to precreated OpenCode session via:
  - `opencode -s <opencodeSessionId> --attach <opencodeServerUrl>`

## Required Capabilities

1. Spawn ensures OpenCode server exists, creates SDK session, sends initial prompt.
2. Send routes through SDK prompt API for OpenCode sessions.
3. Restore rebinds to existing OpenCode session ID and server URL.
4. Activity state is session-specific and non-null during normal operation.
5. Session info includes session ID and summary/cost where available.
6. Kill aborts/deletes OpenCode session and shuts down server process.
7. Web terminal uses attach mode for OpenCode and keeps tmux path for other agents.

## Data Contract (metadata keys)

- `opencodeMode=sdk`
- `opencodeServerUrl=<url>`
- `opencodeServerPid=<pid>`
- `opencodeServerHostname=<host>`
- `opencodeServerPort=<port>`
- `opencodeSessionId=<id>`
- `terminalMode=opencode-attach|tmux`

## Implementation Surfaces

- `packages/core/src/session-manager.ts`
- `packages/core/src/opencode-sdk-service.ts` (new)
- `packages/plugins/agent-opencode/src/index.ts`
- `packages/web/server/direct-terminal-ws.ts`
- `packages/web/server/terminal-websocket.ts`
- `packages/web/src/app/api/sessions/[id]/message/route.ts`
- `packages/integration-tests/src/agent-opencode-sdk.integration.test.ts` (new)

## SDK Method Contract (target)

Use OpenCode v2 SDK surface as canonical adapter API:

- `global.health`
- `session.create`, `session.get`, `session.list`, `session.status`
- `session.prompt`, `session.promptAsync`, `session.messages`, `session.message`
- `session.abort`, `session.delete`, `session.fork`, `session.revert`, `session.unrevert`
- `session.share`, `session.unshare`, `session.summarize`
- `permission.list`, `permission.reply` (for approval parity extension)

## Delivery Slices (Execution Protocol)

Apply this exact sequence for each slice:

1. Execute slice implementation.
2. Commit implementation changes.
3. Run simplifier review with `@claude` subagent.
4. Commit simplifier improvements.
5. Continue to next slice.

### Slice 1

- SDK service + metadata contract

### Slice 2

- SessionManager spawn/send/restore/kill branching for OpenCode

### Slice 3

- `agent-opencode` activity/info migrated to SDK-backed logic

### Slice 4

- web terminal attach mode integration

### Slice 5

- web message API unification through session manager

### Slice 6

- full E2E parity suite

## Definition of Done

- OpenCode lifecycle is SDK-only.
- OpenCode send path no longer relies on runtime keystrokes.
- Web terminal auto-attaches OpenCode sessions via `--attach`.
- E2E tests prove all parity features against real OpenCode execution.
