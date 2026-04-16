# Launch Desk

Repo-local agent for launch planning, narrative packaging, and outbound execution.

This agent is intentionally split into:

- an agent-level system prompt
- a pluggable `launch-mode` slot
- slot configs that select a prompt source and launch strategy

It covers the Launch Desk surfaces called out in the AO Codex site copy:

- `pr`
- `social`
- `outreach`

## Current default

- Slot: `launch-mode`
- Config: `codex`

## Customize

To add another launch mode:

1. Add a new Markdown prompt under `slots/launch-mode/sources/`
2. Add a new config JSON under `slots/launch-mode/configs/`
3. Point `agent.json` at the new config if you want it to become the default
