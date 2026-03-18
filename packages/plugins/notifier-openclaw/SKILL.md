# Agent Orchestrator — OpenClaw Integration

## What it does

Enables **bidirectional communication** between Agent Orchestrator (`ao`) and OpenClaw:
- **ao → OpenClaw**: Escalation notifications (CI failures, review requests, stuck agents)
- **OpenClaw → ao**: Agent commands via shell exec (`ao spawn`, `ao send`, `ao kill`, `ao status`)

## When to use it

Use this integration when:
- You need to spawn persistent coding sessions from OpenClaw
- You want `ao` escalations delivered to your OpenClaw chat
- You need to manage `ao` sessions from within OpenClaw

## Setup

### 1. Configure ao notifier

Add to `agent-orchestrator.yaml`:
```yaml
defaults:
  notifiers: [desktop, openclaw]

notifiers:
  openclaw:
    plugin: openclaw
    url: "http://127.0.0.1:18789/hooks/agent"
    token: "${OPENCLAW_HOOKS_TOKEN}"

notificationRouting:
  urgent: [openclaw, desktop]
  action: [openclaw]
  warning: [openclaw]
  info: [openclaw]
```

### 2. Configure OpenClaw hooks

In OpenClaw config:
```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:ao:"],
    defaultSessionKey: "hook:ao:default"
  }
}
```

### 3. Use ao from OpenClaw

Once configured, use shell commands from OpenClaw to control `ao`:

```bash
# Spawn a session for an issue
ao spawn my-project #42

# Spawn for ad-hoc repo
ao spawn --repo ComposioHQ/integrator #42

# Check status
ao status

# Send instructions to a session
ao send ao-5 "Fix the failing test in auth.test.ts"

# Kill a stuck session
ao kill ao-5
```

## Notification flow

When `ao` detects an event (CI failure, review comments, stuck agent):
1. Lifecycle manager produces an escalation event
2. `notifier-openclaw` sends webhook to OpenClaw (`POST /hooks/agent`)
3. OpenClaw delivers the message with session context
4. You respond via chat; OpenClaw executes `ao` commands

## Session key convention

Each `ao` session maps to an OpenClaw session key: `hook:ao:<session-id>`
- Example: `hook:ao:ao-5`, `hook:ao:ao-12`
- Preserves per-session escalation history
- Enables continuity for retries and human follow-up
