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
    url: ${OPENCLAW_HOOKS_URL}
    token: ${OPENCLAW_HOOKS_TOKEN}
    sessionKeyPrefix: "hook:ao:"
    wakeMode: now
    deliver: true
    # Set both fields for fixed routing; otherwise OpenClaw may reuse its last target
    channel: discord
    to: "1481253232679325817"
```

## Behavior

- Sends `POST /hooks/agent` payloads with per-session key `hook:ao:<sessionId>`.
- Defaults `wakeMode: now` and `deliver: true`.
- Includes `channel` and `to` in the payload when configured for deterministic routing.
- Retries on `429` and `5xx` responses with exponential backoff.
- If `deliver: true` is set without `channel` or `to`, final delivery depends on OpenClaw-side destination resolution.

## Smoke test

Use [`scripts/openclaw-notifier-smoke.sh`](../../../scripts/openclaw-notifier-smoke.sh) with env vars only:

```bash
export OPENCLAW_HOOKS_URL="http://127.0.0.1:18789/hooks/agent"
export OPENCLAW_HOOKS_TOKEN="..."
export AO_DIR="$HOME/.agent-orchestrator"
export OPENCLAW_CHANNEL_KIND="discord"
export OPENCLAW_CHANNEL_TARGET="1481253232679325817"

./scripts/openclaw-notifier-smoke.sh
```

See [`docs/openclaw-notifier-setup.md`](../../../docs/openclaw-notifier-setup.md) for the full setup and expected output.

## Token rotation

1. Rotate `hooks.token` in OpenClaw.
2. Update `OPENCLAW_HOOKS_TOKEN` used by AO.
3. Verify old token returns `401` and new token returns `200`.

## Known limitation (Phase 0)

- OpenClaw hook ingest is not idempotent by default. Replayed webhook payloads are processed as separate runs.
- Owner: AO integration.
- Follow-up: add stable event id/idempotency key support.
