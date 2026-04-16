# Design Studio

Repo-local agent for shaping a startup's first brand and product surface.

This agent is intentionally split into:

- an agent-level system prompt
- a pluggable `design-mode` slot
- slot configs that select a prompt source and design strategy

Its job is to turn a concept into:

- a distinctive brand system
- product UI direction that can actually be built
- landing page copy that sounds like a founder, not a template

## Current default

- Slot: `design-mode`
- Config: `codex`

## Customize

To add another design mode:

1. Add a new Markdown prompt under `slots/design-mode/sources/`
2. Add a new config JSON under `slots/design-mode/configs/`
3. Point `agent.json` at the new config if you want it to become the default
