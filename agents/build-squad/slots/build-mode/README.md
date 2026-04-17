# Build Mode Slot

This slot holds configurable delivery strategies for the `build-squad` agent.

Each config selects:

- a prompt source
- the core delivery roles
- how architecture and implementation should be decomposed
- the expected output shape
- the quality gates for handoff
- the artifacts left behind for review and release

Current configs:

- `codex.json`: AO-native parallel build mode for architect, backend, frontend, and qa
