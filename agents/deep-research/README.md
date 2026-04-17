# Deep Research

Repo-local agent for market sizing, competitive teardown, and user interview synthesis.

This agent is intentionally standalone while shared `research-mode` infra lands.

Its job is to:

- size the market without hand-wavy TAM theater
- map direct and adjacent competitors
- synthesize interview evidence into demand signals
- write the one-pager that tells you if an idea deserves to exist

## Current default

- Slot: `research-mode`
- Config: `codex`

## Customize

To add another research mode:

1. Add a new Markdown prompt under `slots/research-mode/sources/`
2. Add a new config JSON under `slots/research-mode/configs/`
3. Update `agent.json` if you want the new config to become the default
