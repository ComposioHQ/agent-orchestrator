# Build Squad

Repo-local engineering swarm for architecture, implementation, and QA.

This agent is intentionally split into:

- an agent-level system prompt
- a pluggable `build-mode` slot
- slot configs that define how the squad plans, ships, and verifies work

## Current default

- Slot: `build-mode`
- Config: `codex`
- Roles: `architect`, `backend`, `frontend`, `qa`

## Standalone for now

This folder is intentionally self-contained until the shared `build-mode` schema and validator support land in a separate infra change.

## Customize

To add another build mode:

1. Add a new Markdown prompt under `slots/build-mode/sources/`
2. Add a new config JSON under `slots/build-mode/configs/`
3. Point `agent.json` at the new config if you want it to become the default
