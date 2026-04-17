# Idea Validation Slot

This slot holds configurable idea-validation strategies for the `idea-validator` agent.

Each config selects:

- a prompt source
- an upstream idea source agent/config
- a research depth
- an output shape
- preferred source types
- research dimensions
- scoring axes and scale

Current configs:

- `codex.json`: web-research-heavy validation of ideas sourced from `idea-sourcer`
