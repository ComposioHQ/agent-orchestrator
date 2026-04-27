"@aoagents/ao-cli": patch
"@aoagents/ao-core": patch
"@aoagents/ao-web": patch
---

Make project orchestrators deterministic and idempotent.

- ensure each project uses the canonical `{prefix}-orchestrator` session instead of creating numbered main orchestrators
- make `ao start`, the dashboard, and the orchestrator API reuse or restore the canonical session
- keep legacy numbered orchestrators visible as stale sessions without treating them as the main orchestrator
