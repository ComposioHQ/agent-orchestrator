# Growth Loop

Repo-local agent for acquisition experimentation, funnel instrumentation, and conversion optimization.

This agent is intentionally separate from the rest of the startup factory swarm.

Its job is to:

- design acquisition experiments instead of generic marketing plans
- instrument the funnel before interpreting results
- tighten conversion copy across landing, signup, and onboarding surfaces
- run a measurable growth loop that reports what moved

## Current default

- Slot: `growth-mode`
- Config: `codex`

## Customize

To add another growth mode:

1. Add a new Markdown prompt under `slots/growth-mode/sources/`
2. Add a new config JSON under `slots/growth-mode/configs/`
3. Update `agent.json` if you want the new config to become the default
