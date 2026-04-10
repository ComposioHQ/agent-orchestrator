# notifier-openclaw

OpenClaw notifier plugin for AO escalation events.

## Quick setup

```bash
ao setup openclaw
```

This interactive wizard auto-detects your OpenClaw gateway, validates the connection, and writes the config. For non-interactive use (e.g., in CI/CD pipelines or automation scripts):

```bash
ao setup openclaw --url http://127.0.0.1:18789/hooks/agent --token YOUR_TOKEN --non-interactive
```

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

## Token rotation

1. Rotate `hooks.token` in OpenClaw.
2. Update `OPENCLAW_HOOKS_TOKEN` used by AO.
3. Verify old token returns `401` and new token returns `200`.

## Known limitation (Phase 0)

- OpenClaw hook ingest is not idempotent by default. Replayed webhook payloads are processed as separate runs.
- Owner: AO integration.
- Follow-up: add stable event id/idempotency key support.
