## Summary
Implements the foundation for plugin ecosystem expansion:
- Config-driven plugin loading for non-builtin plugins
- Practical plugin config extraction/normalization
- Test coverage for dynamic loading and config forwarding
- Research distillation document with prioritized plugin roadmap

Closes: <!-- replace with issue number after issue creation, e.g. #123 -->

## Changes
- `packages/core/src/plugin-registry.ts`
- `packages/core/src/__tests__/plugin-registry.test.ts`
- `docs/research/orchestrator-plugin-distillation-2026-02-25.md`
- `.github/issue-drafts/plugin-ecosystem-expansion.md`
- `.github/pr-drafts/plugin-ecosystem-expansion.md`

## Validation
- `pnpm --filter @composio/ao-core test -- plugin-registry`
