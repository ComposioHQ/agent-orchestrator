## Title
Plugin Ecosystem Expansion: config-driven loading + prioritized integration roadmap

## Summary
This issue tracks the plugin expansion program based on ecosystem distillation in `docs/research/orchestrator-plugin-distillation-2026-02-25.md`.

## Context
AO already has a slot-based plugin architecture but needed stronger config-driven loading to scale to additional integrations.

## Completed in this change
- Config-driven external plugin loading in `PluginRegistry`
- Plugin config forwarding improvements (`notifier`, `terminal-web`)
- Test coverage updates for registry behavior

## Next milestones
1. Implement `tracker-jira`
2. Implement `scm-gitlab`
3. Implement `runtime-docker`
4. Add MCP gateway capability
5. Add telemetry sink plugin contract

## Acceptance criteria
- New plugins can be loaded by config without core edits
- Plugin package naming convention supported
- Direct package/local-path plugin imports supported
- Failing plugin imports do not crash startup

## References
- `docs/research/orchestrator-plugin-distillation-2026-02-25.md`
