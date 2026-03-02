# OpenCode SDK E2E Plan (Live Execution)

## Intent

Validate every parity feature with real execution:

- real `opencode` binary
- real OpenCode server/session
- real SDK API calls
- real orchestrator metadata
- real terminal attach path

## Cheap Model Strategy

At test bootstrap:

1. run `opencode models --verbose`
2. choose first available in priority:
   1. `opencode/gpt-5-nano`
   2. `opencode/minimax-m2.5-free`
   3. `opencode/trinity-large-preview-free`
   4. `opencode/claude-3-5-haiku`
3. allow override via `AO_TEST_NANO_MODEL`

## Test File

- `packages/integration-tests/src/agent-opencode-sdk.integration.test.ts`

## Helper Files

- `packages/integration-tests/src/helpers/opencode.ts`
- `packages/integration-tests/src/helpers/opencode-export.ts`

## 12 E2E Cases

## T01 SDK bootstrap
- spawn OpenCode project session through `sessionManager.spawn`
- assert SDK/server initialization succeeds

## T02 server metadata + health
- assert metadata contains `opencodeServerUrl`, `opencodeServerPid`, `opencodeSessionId`
- assert `GET <opencodeServerUrl>/global/health` returns healthy

## T03 session creation continuity
- assert stored `opencodeSessionId` resolves via SDK `session.get`
- assert `opencode export <id>` includes same id

## T04 send path correctness
- call `sessionManager.send(sessionId, markerPrompt)`
- assert export contains user marker and assistant turn after it

## T05 activity state quality
- sample `agent.getActivityState(session)` during and after prompt
- assert non-null live state, then `exited` on stop

## T06 session info isolation
- run 2 sessions in same workspace with different markers
- assert each AO session maps to distinct `opencodeSessionId`

## T07 restore continuity
- send marker A, restore, send marker B
- assert both markers exist in one exported OpenCode session

## T08 kill cleanup
- kill AO session
- assert OpenCode session aborted/deleted and server pid no longer alive

## T09 terminal attach mode
- open web terminal backend for OpenCode session
- assert command is `opencode -s <id> --attach <url>` in workspace cwd

## T10 tmux compatibility
- non-OpenCode session still uses tmux attach flow

## T11 web message route unification
- POST `/api/sessions/[id]/message`
- assert message lands in OpenCode session via session-manager path

## T12 lifecycle smoke
- list/get/send/restore/kill over multiple sessions
- assert metadata invariants stay valid throughout

## Deterministic Assertions

- Use marker prompts: `AO_E2E_MARKER_<timestamp>`
- Prompt: `Reply with exactly: <MARKER>`
- Verify markers via `opencode export <sessionId>` JSON output

## Run Command

```bash
pnpm --filter @composio/ao-integration-tests exec vitest run --config vitest.config.ts src/agent-opencode-sdk.integration.test.ts
```
