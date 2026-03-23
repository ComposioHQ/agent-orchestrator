# notifier-openclaw

OpenClaw notifier plugin for AO escalation events.

Phase 1 adds operational controls for OpenClaw-side command adapters, AO health polling helpers, and anti-spam escalation guardrails.

## Required OpenClaw config (`openclaw.json`)

```json
{
  "hooks": {
    "enabled": true,
    "token": "<your-hooks-token>",
    "allowRequestSessionKey": true,
    "allowedSessionKeyPrefixes": ["hook:"]
  }
}
```

## AO config (`agent-orchestrator.yaml`)

```yaml
notifiers:
  openclaw:
    plugin: openclaw
    url: http://127.0.0.1:18789/hooks/agent
    token: ${OPENCLAW_HOOKS_TOKEN}
```

## Behavior

- Sends `POST /hooks/agent` payloads with per-session key `hook:ao:<sessionId>`.
- Defaults `wakeMode: now` and `deliver: true`.
- Retries on `429` and `5xx` responses with exponential backoff.
- Debounces repeated escalations for the same `sessionId + type + reason` in a rolling window.
- Batches burst escalations into a compact summary notification.

## Phase 1 operational commands

Use these helpers inside an OpenClaw plugin command handler (no AI turn required):

- `/ao status <sessionId?>`
- `/ao sessions`
- `/ao retry <sessionId>`
- `/ao kill <sessionId>`

Programmatic API (from this package):

```ts
import {
  parseAoAutoReplyCommand,
  executeAoAutoReplyCommand,
  createAoCliRunner,
} from "@composio/ao-plugin-notifier-openclaw";

const parsed = parseAoAutoReplyCommand("/ao status ao-7");
if (parsed) {
  const result = await executeAoAutoReplyCommand(parsed, {
    runner: createAoCliRunner(),
  });
  // result.message is deterministic and compact
}
```

Response format examples:

- `AO status session=ao-7 status=working activity=active last=2m`
- `AO sessions total=3 active=2 degraded=1 dead=0 ids=ao-1,ao-2,ao-7`
- `Retry queued for ao-7`
- `Session killed: ao-7`

Error format examples:

- `AO CLI unavailable` (`code=ao_unavailable`)
- `AO CLI command failed (<exitCode>)` (`code=ao_command_failed`)

## AO health polling helper

Use `AoHealthPollingService` + `collectAoHealthSummary()` to publish periodic AO health snapshots:

- active / degraded / dead session counts
- stale session detection (`lastActivity >= staleAfterMinutes`)
- failed `ao send` / spawn command counters (from shared metrics object)

```ts
import { AoHealthPollingService } from "@composio/ao-plugin-notifier-openclaw";

const service = new AoHealthPollingService({
  pollIntervalMs: 30000,
  staleAfterMinutes: 15,
  onSummary: async (summary) => {
    // route to chat/logging
  },
});

service.start();
```

## Permissions and runtime expectations

- OpenClaw process needs permission to execute local `ao` CLI.
- `ao` must be available in `PATH` for command adapters and health polling.
- OpenClaw needs network access to AO-local resources only if your handlers call networked tools.
- AO notifier requires permission to reach `http://127.0.0.1:18789/hooks/agent`.

## Troubleshooting checklist

1. `hooks.token` mismatch:
   - Verify OpenClaw `hooks.token`.
   - Verify AO `token` / `OPENCLAW_HOOKS_TOKEN`.
   - Confirm webhook returns `200` (not `401`).
2. Missing AO binary:
   - Run `which ao` in OpenClaw runtime shell.
   - Ensure `PATH` for service process includes AO install location.
3. Commands failing intermittently:
   - Check AO stderr in command adapter response (`ao_command_failed`).
   - Increase CLI timeout (runner option `timeoutMs`) if needed.
4. Escalation noise too high:
   - Increase `debounceWindowMs`.
   - Lower `batchTriggerCount` and tune `batchWindowMs`.
5. No health summaries:
   - Verify `AoHealthPollingService.start()` is invoked.
   - Ensure `onSummary` handler does not throw.

## Token rotation

1. Rotate `hooks.token` in OpenClaw.
2. Update `OPENCLAW_HOOKS_TOKEN` used by AO.
3. Verify old token returns `401` and new token returns `200`.

## Known limitation

- Webhook ingest is still text/webhook-first in Phase 1 (no dedicated AO reverse API).
