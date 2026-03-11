# OpenClaw Notifier Setup

Use env vars only. Do not put `OPENCLAW_HOOKS_TOKEN`, `LINEAR_API_KEY`, or any other token in git-tracked files.

## AO config

Add an OpenClaw notifier entry with explicit destination routing so delivery does not fall back to OpenClaw's remembered last target:

```yaml
notifiers:
  openclaw:
    plugin: openclaw
    url: ${OPENCLAW_HOOKS_URL}
    token: ${OPENCLAW_HOOKS_TOKEN}
    sessionKeyPrefix: "hook:ao:"
    wakeMode: now
    deliver: true
    channel: discord
    to: "1481253232679325817"
```

`channel` and `to` should match the destination you want OpenClaw to deliver into every time.

## Smoke test

```bash
export OPENCLAW_HOOKS_URL="http://127.0.0.1:18789/hooks/agent"
export OPENCLAW_HOOKS_TOKEN="..."
export AO_DIR="$HOME/.agent-orchestrator"
export OPENCLAW_CHANNEL_KIND="discord"
export OPENCLAW_CHANNEL_TARGET="1481253232679325817"

./scripts/openclaw-notifier-smoke.sh
```

Expected result:

- script prints the exact `channel` and `to` it is sending
- HTTP status is `200` or another `2xx`
- OpenClaw response body is printed
- the notification lands in the configured Discord or Telegram destination, not the previous fallback target

If you want a different destination, change `OPENCLAW_CHANNEL_KIND` and `OPENCLAW_CHANNEL_TARGET` before rerunning the script.
