# AGENTS.md

> Full project context, architecture, conventions, and plugin standards are in **CLAUDE.md**.

## Commands

```bash
pnpm install                            # Install dependencies
pnpm build                              # Build all packages
pnpm dev                                # Web dashboard dev server (Next.js + 2 WS servers)
pnpm typecheck                          # Type check all packages
pnpm test                               # All tests (excludes web)
pnpm --filter @aoagents/ao-web test     # Web tests
pnpm lint                               # ESLint check
pnpm lint:fix                           # ESLint fix
pnpm format                             # Prettier format
```

## Architecture TL;DR

Monorepo (pnpm) with packages: `core`, `cli`, `web`, and `plugins/*`. The web dashboard is a Next.js 15 app (App Router) with React 19 and Tailwind CSS v4. Data flows from `agent-orchestrator.yaml` through core's `loadConfig()` to API routes, served via SSR and a 5s-interval SSE stream. Terminal sessions use WebSocket connections to tmux PTYs. See CLAUDE.md for the full plugin architecture (8 slots), session lifecycle, and data flow.

## Working Principles

- **Think before coding.** State assumptions. Ask when unclear. Push back when a simpler approach exists.
- **Simplicity first.** No speculative features. No abstractions for single-use code. Plugin slots are the extension point.
- **Surgical changes.** Touch only what you must. Match existing style. Don't refactor things that aren't broken. Every changed line traces to the task.
- **Goal-driven.** Define verifiable success criteria before implementing. Write tests that reproduce bugs before fixing them.

Full guidelines with AO-specific context: see "Working Principles" in CLAUDE.md.

## Key Files

- `packages/core/src/types.ts` — All plugin interfaces (Agent, Runtime, Workspace, etc.)
- `packages/core/src/session-manager.ts` — Session CRUD
- `packages/core/src/lifecycle-manager.ts` — State machine + polling loop
- `packages/web/src/components/Dashboard.tsx` — Main dashboard view
- `packages/web/src/components/SessionDetail.tsx` — Session detail view
- `packages/web/src/app/globals.css` — Design tokens
