## Summary
Implements the foundation for plugin ecosystem expansion:
- Config-driven plugin loading for non-builtin plugins
- Practical plugin config extraction/normalization
- Test coverage for dynamic loading and config forwarding
- Research distillation document with prioritized plugin roadmap

Closes: #216

## Changes
- `packages/core/src/plugin-registry.ts`
- `packages/core/src/__tests__/plugin-registry.test.ts`
- `packages/cli/src/lib/plugins.ts`
- `packages/cli/package.json`
- `packages/cli/__tests__/lib/plugins.test.ts`
- `packages/plugins/agent-gemini/*`
- `packages/plugins/agent-goose/*`
- `packages/plugins/agent-amazon-q/*`
- `packages/plugins/agent-kiro/*`
- `packages/plugins/notifier-discord/*`
- `packages/plugins/notifier-teams/*`
- `packages/plugins/notifier-telegram/*`
- `packages/plugins/terminal-kitty/*`
- `packages/plugins/terminal-wezterm/*`
- `packages/plugins/runtime-docker/*`
- `packages/plugins/tracker-jira/*`
- `packages/plugins/scm-gitlab/*`
- `packages/plugins/notifier-email/*`
- `packages/plugins/terminal-zellij/*`
- `docs/research/orchestrator-plugin-distillation-2026-02-25.md`
- `docs/research/plugin-distillation-implementation-update-2026-02-26.md`
- `plugin-distillation-research.md`
- `plugin-catalog-industry-standard.md`
- `.github/issue-drafts/plugin-ecosystem-expansion.md`
- `.github/pr-drafts/plugin-ecosystem-expansion.md`

## Validation
- `pnpm --filter @composio/ao-core test -- plugin-registry`
- Additional plugin/package tests were added, but full workspace execution is currently blocked in this environment because `pnpm install` cannot reach `registry.npmjs.org` (DNS/network restriction).
