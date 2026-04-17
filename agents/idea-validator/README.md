# Idea Validator

Repo-local agent for research-backed idea validation and ranking.

This agent is intentionally separate from `idea-sourcer`.

Its job is to:

- pull candidate ideas from the sourcer agent
- research competition, timing tailwinds, and demand signals
- score ideas for current relevance
- separate exciting ideas from durable opportunities

## Current default

- Slot: `idea-validation`
- Config: `codex`

## Customize

To add another validation mode:

1. Add a new Markdown prompt under `slots/idea-validation/sources/`
2. Add a new config JSON under `slots/idea-validation/configs/`
3. Update `agent.json` if you want the new config to become the default
