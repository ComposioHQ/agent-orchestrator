# Idea Sourcer

Repo-local agent for research-backed idea generation.

This agent is intentionally split into:

- an agent-level system prompt
- a pluggable `idea-generation` slot
- slot configs that select a prompt source and strategy

## Current default

- Slot: `idea-generation`
- Config: `codex`

## Customize

To add another idea-generation mode:

1. Add a new Markdown prompt under `slots/idea-generation/sources/`
2. Add a new config JSON under `slots/idea-generation/configs/`
3. Point `agent.json` at the new config if you want it to become the default
