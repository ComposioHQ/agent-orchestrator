# Idea Generation Slot

This slot holds configurable idea-generation strategies for the `idea-sourcer` agent.

Each config selects:

- a prompt source
- a research depth
- a novelty bar
- an output shape
- preferred source types
- scoring axes for ranking ideas

Current configs:

- `codex.json`: research-heavy, high-novelty, Codex-native idea generation
