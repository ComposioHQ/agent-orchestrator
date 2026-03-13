# notifier-openclaw

OpenClaw notifier plugin for AO escalation events.

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
- Adds stable `event_id` to webhook payloads and includes `Event ID: <id>` in escalation messages.
- Defaults `wakeMode: now` and `deliver: true`.
- Retries on `429` and `5xx` responses with exponential backoff.
- Deduplicates recent escalation replays per `sessionKey + event_id` for `idempotencyTtlMs` (default: `300000`).

## Token rotation

1. Rotate `hooks.token` in OpenClaw.
2. Update `OPENCLAW_HOOKS_TOKEN` used by AO.
3. Verify old token returns `401` and new token returns `200`.

## Idempotency window config

```yaml
notifiers:
  openclaw:
    plugin: openclaw
    idempotencyTtlMs: 300000
```
