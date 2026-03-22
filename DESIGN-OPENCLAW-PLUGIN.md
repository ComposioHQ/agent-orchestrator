# DESIGN: OpenClaw Integration for AO (Revised)

## Executive Summary
This design is revised to match how OpenClaw actually works and to minimize time-to-value.

- Phase 0-2 uses existing primitives:
  - AO `notifier-openclaw` (outbound)
  - OpenClaw built-in webhook ingress (`POST /hooks/agent`)
  - OpenClaw agent `exec` tool and plugin commands (`api.registerCommand`) for reverse control
- No new AO `peer` slot in early phases.
- Full structured peer protocol, HMAC, and RBAC are deferred to Phase 3 (cross-network / multi-tenant hardening).

This ships fast while solving current operational fragility.

## What Was Correct vs What Changes

## Keep
- Escalation envelope concept and session-supervision goals are sound.
- Need bidirectional path and human override.
- Need durable session identity, dead-session detection, crash forensics, and send reliability signal.

## Change
- Do not start with a custom OpenClaw bridge extension for event ingress.
- Do not add AO reverse-command API in Phase 0-2.
- Do not introduce AO `peer` slot yet.

## Ground Truth Architecture

## OpenClaw capabilities (used here)
OpenClaw already supports:
- Webhook ingress: `POST /hooks/agent`, `POST /hooks/wake`
- Plugin system: commands, services, gateway methods/handlers, tools, channels, CLI
- Auto-reply command registration: `api.registerCommand(...)` (no AI turn)
- Agent execution path with shell/exec tools

## AO capabilities (used here)
- Escalation event production via `lifecycle-manager.ts`
- Notifier plugin interface (`notify`)
- Reliable-ish session send path in `session-manager.send(...)` including confirmation heuristics

## Phase 0 Design (Ship in ~1 day)

## Flow
1. AO escalation event triggers `notifier-openclaw.notify(...)`.
2. `notifier-openclaw` posts to OpenClaw webhook:
   - `POST http://127.0.0.1:18789/hooks/agent`
   - `Authorization: Bearer <hooks.token>`
3. OpenClaw runs an agent turn and delivers to chat channel(s).
4. Human replies in chat; OpenClaw agent runs `ao send/ao kill/ao session ...` via exec tools.

## Request payload (Phase 0)
```json
{
  "message": "[AO Escalation] ao-5 failed CI 5 times on feat/ci-auto-injection. Last error: type mismatch in codex plugin. PR: github.com/ComposioHQ/agent-orchestrator/pull/123. Actions available: retry, skip, kill. Context: {\"sessionId\":\"ao-5\",\"projectId\":\"ao\",\"reason\":\"ci_failed\",\"attempts\":5}",
  "name": "AO",
  "sessionKey": "hook:ao:ao-5",
  "wakeMode": "now",
  "deliver": true
}
```

## Session key strategy (required)
Use one OpenClaw session per AO session:
- `hook:ao:<ao-session-id>` (examples: `hook:ao:ao-5`, `hook:ao:ao-12`)

Benefits:
- Preserves per-session escalation history.
- Enables continuity for retries/human follow-up.
- Avoids cross-session context bleed.

Security config:
- `hooks.allowRequestSessionKey: true`
- `hooks.allowedSessionKeyPrefixes: ["hook:ao:"]`

## Why this is the right Phase 0
- Zero OpenClaw plugin code required.
- Uses stable OpenClaw ingress/auth/session behavior.
- Immediate bidirectional operations through existing agent exec path.

## Phase 1 Design (Lightweight OpenClaw plugin)

Add a small OpenClaw plugin focused on UX + ops speed, not transport replacement.

## Plugin responsibilities
1. Register auto-reply commands (`api.registerCommand`):
- `/ao status <id>`
- `/ao sessions`
- `/ao retry <id>`
- `/ao kill <id>`

These execute without invoking an AI turn for fast deterministic actions.

2. Register background service (`api.registerService`):
- Periodic AO health polling (`ao session ls/status`), summarize anomalies.
- Trigger chat updates when dead/stuck sessions detected.

3. Keep complex tasks on normal agent path:
- For multi-step remediation, let AI run with exec tools (`ao send`, diagnostics, fixes).

## Phase 2 Design (Structured OpenClaw plugin)

Add structured AO interactions while keeping Phase 0 compatibility.

## Additions
- Gateway HTTP handler(s) in plugin for structured AO event ingress (optional alongside `/hooks/agent`).
- Agent tools for AO structured reads/actions (e.g., `ao_session_info`, `ao_session_send`).
- Better supervisor event formatting and correlation across chat threads.

Still no AO peer slot required.

## Phase 3 Design (Optional hardened peer protocol)

Only if needed (cross-host, multi-tenant, compliance):
- Dedicated AO peer abstraction.
- Signed envelopes (HMAC), replay protection, RBAC, strict command API.

## Escalation Message Contract (Phase 0-2)

Keep escalation semantics consistent even in text form.

Canonical logical shape:
```json
{
  "type": "escalation",
  "from": "ao-5",
  "reason": "ci_failed",
  "attempts": 5,
  "context": {
    "projectId": "ao",
    "branch": "feat/ci-auto-injection",
    "pr": "https://github.com/.../pull/123",
    "lastError": "..."
  },
  "actions": ["retry", "skip", "kill"]
}
```

In Phase 0 this is embedded in webhook `message` text plus compact JSON context. In Phase 2+ it can be fully structured.

## Session Supervision Requirements (Operational)

## 1) Health monitoring
- AO should emit/update session health snapshots periodically.
- OpenClaw Phase 1 service polls and reports dead/stuck sessions.

Simplest Phase 0 bootstrap:
- AO writes status snapshots to a known file.
- OpenClaw reads during heartbeat cycle and surfaces anomalies.

## 2) Auto-respawn
- If session dies unexpectedly, workflow should attempt `ao session restore <id>` first.
- If restore fails, spawn replacement with preserved task metadata and explicit mapping notice.

## 3) Stable session identity
Persist task identity independent of numeric ID:
- `logicalSessionKey` (task/issue/PR anchored)
- `taskRef`
- `branch`
- `prUrl`

Respawn/replacement must carry the same logical identity.

## 4) Crash forensics
On failure detection, capture before cleanup:
- last pane output (`tmux capture-pane` tail),
- AO/agent/runtime error signature,
- known classifiers (e.g. permission/auth/config crash).

Include this in escalation message.

## 5) `ao send` delivery confidence
Expose send result confidence in escalations/acks:
- `accepted`
- `confirmed`
- `uncertain`
- `failed`

`uncertain` must not be shown as success.

## Graceful Degradation

If OpenClaw is down/unreachable:
- `notifier-openclaw` fails over per policy to:
  - desktop notifier and/or
  - webhook/file sink for later replay
- AO must log unsent escalation payloads with retry metadata.

## Rate Limiting / Debounce

Avoid chat spam when many sessions fail simultaneously:
- Batch window: e.g. 10-30s aggregation by `projectId/reason`.
- Collapse repeated identical escalations per `sessionId` within cooldown.
- Send summary + top actionable items when burst detected.

## Security by Phase

## Phase 0-1 (localhost)
- Loopback transport + OpenClaw `hooks.token` auth is sufficient.
- No HMAC/RBAC requirement initially.

## Phase 2+
- Add tighter sender policy for plugin commands.

## Phase 3
- HMAC signatures, replay protection, AO-side RBAC for structured API.

## Reference OpenClaw plugin patterns to follow
When implementing Phase 1/2 plugin, model structure after:
- Voice Call plugin (`@openclaw/voice-call`): command + tool + service + RPC pattern.
- Teams/Matrix channel plugins for robust bidirectional routing patterns.
- Memory plugins for slot/service/tool separation patterns.

## `agent-orchestrator.yaml` (Phase 0)

```yaml
defaults:
  notifiers: [desktop, openclaw]

notifiers:
  openclaw:
    plugin: openclaw
    url: "http://127.0.0.1:18789/hooks/agent"
    token: "${OPENCLAW_HOOKS_TOKEN}"
    retries: 3
    retryDelayMs: 1000

notificationRouting:
  urgent: [openclaw, desktop]
  action: [openclaw]
  warning: [openclaw]
  info: [openclaw]
```

OpenClaw config requirements:
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

## Required AO changes for Phase 0
1. Implement `notifier-openclaw` using webhook POST semantics.
2. Add payload formatter producing action-oriented escalation text + compact context.
3. Add burst control (debounce/batch) in notifier path.
4. Add fallback routing when OpenClaw is unavailable.

## Required AO/OpenClaw changes for Phase 1
1. OpenClaw plugin with `api.registerCommand` for deterministic `/ao ...` commands.
2. OpenClaw service with `api.registerService` for periodic AO health polling.
3. AO metadata additions for logical session identity and crash forensics fields.

## Revised rollout plan
- Phase 0: AO notifier -> OpenClaw `/hooks/agent`, per-session `hook:ao:*` keys, agent exec for reverse actions.
- Phase 1: OpenClaw plugin commands + health polling service.
- Phase 2: Structured plugin handlers/tools for AO supervisor events and richer automation.
- Phase 3: Optional dedicated peer protocol/security hardening.

## Final Recommendation
Use existing mechanisms first: notifier + webhook + exec + plugin commands. This delivers immediate operational value and directly addresses session durability pain. Defer new abstractions until Phase 3, when complexity is justified.
