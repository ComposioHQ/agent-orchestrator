---
tags: [index, agent-orchestrator]
created: 2026-03-04
updated: 2026-03-04
---

# Agent Orchestrator

Open-source TypeScript system for orchestrating parallel AI coding agents. Agent-agnostic (Claude Code, Codex, Aider), runtime-agnostic (tmux, Docker, k8s), tracker-agnostic (GitHub, Linear, Jira). Manages session lifecycle, tracks PR/CI/review state, auto-handles routine issues, and pushes notifications to humans only when judgment is needed.

**Core principle: Push, not pull.** Spawn agents, walk away, get notified when your judgment is needed.

## Architecture

- [[overview]] -- System design, data flow, and design principles
- [[plugin-system]] -- 8 swappable plugin slots and the plugin pattern
- [[cli-and-web]] -- CLI commands and Next.js web dashboard

## Key Facts

- **Monorepo**: pnpm workspaces with `packages/core`, `packages/cli`, `packages/web`, and `packages/plugins/*`
- **Core types**: All plugin interfaces defined in `packages/core/src/types.ts` -- read this file first
- **Config**: `agent-orchestrator.yaml` (Zod-validated, supports `~` expansion, per-project plugin overrides)
- **Stateless design**: No database; flat metadata files (`key=value`) + JSONL event log under `~/.agent-orchestrator/`
- **Testing**: vitest, 3,288+ test cases; run `pnpm test`
- **Tech stack**: TypeScript (ESM), Node 20+, Next.js 15, React 19, Tailwind, Commander.js, SSE for real-time
- **Security**: Always `execFile` (never `exec`), validate all external input, no shell interpolation

## Related

- [[github/three-sword-style-ai/obsidian/_index|Three Sword Style AI]]
