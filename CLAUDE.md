# CLAUDE.md — Agent Orchestrator

## What This Is

Open-source system for orchestrating parallel AI coding agents. Agent-agnostic (Claude Code, Codex, Aider), runtime-agnostic (tmux, docker, k8s), tracker-agnostic (GitHub, Linear, Jira). Manages session lifecycle, tracks PR/CI/review state, auto-handles routine issues (CI failures, review comments), pushes notifications to humans only when needed.

**Core principle: Push, not pull.** Spawn agents, walk away, get notified when your judgment is needed.

## Tech Stack

TypeScript (ESM), Node 20+, pnpm workspaces. Next.js 15 (App Router) + Tailwind. Commander.js CLI. YAML + Zod config. Server-Sent Events for real-time. Flat metadata files + JSONL event log. ESLint + Prettier. vitest.

## Architecture

8 plugin slots — every abstraction is swappable:

| Slot      | Interface   | Default Plugin |
| --------- | ----------- | -------------- |
| Runtime   | `Runtime`   | tmux           |
| Agent     | `Agent`     | claude-code    |
| Workspace | `Workspace` | worktree       |
| Tracker   | `Tracker`   | github         |
| SCM       | `SCM`       | github         |
| Notifier  | `Notifier`  | desktop        |
| Terminal  | `Terminal`  | iterm2         |
| Lifecycle | (core)      | —              |

**All interfaces defined in `packages/core/src/types.ts` — read this file first.**

## Directory Structure

```
packages/
  core/          — @composio/ao-core (types, config, services)
  cli/           — @composio/ao-cli (the `ao` command)
  web/           — @composio/ao-web (Next.js dashboard)
  plugins/
    runtime-{tmux,process}/
    agent-{claude-code,codex,aider,opencode}/
    workspace-{worktree,clone}/
    tracker-{github,linear}/
    scm-github/
    notifier-{desktop,slack,composio,webhook}/
    terminal-{iterm2,web}/
```

## Key Files (Read These First)

1. `packages/core/src/types.ts` — all interfaces (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal)
2. `agent-orchestrator.yaml.example` — config format
3. Plugin examples:
   - `packages/plugins/runtime-tmux/src/index.ts` — Runtime implementation
   - `packages/plugins/agent-claude-code/src/index.ts` — Agent implementation
4. This file (CLAUDE.md) — code conventions

## TypeScript Conventions (MUST follow)

- **ESM modules** — `"type": "module"` in all packages
- **`.js` extensions in imports** — `import { foo } from "./bar.js"` (required for ESM)
- **`node:` prefix for builtins** — `import { readFileSync } from "node:fs"`
- **Strict mode** — `"strict": true` in tsconfig
- **`type` imports** — `import type { Foo }` for type-only (enforced by ESLint)
- **No `any`** — use `unknown` + type guards (ESLint error)
- **No unsafe casts** — `as unknown as T` bypasses type safety, validate instead
- **Prefer `const`** — `let` only when reassignment needed, never `var`
- **Semicolons, double quotes, 2-space indent** — enforced by Prettier

## Plugin Pattern (MUST follow)

Every plugin exports a `PluginModule` with inline `satisfies` for compile-time type checking:

```typescript
import type { PluginModule, Runtime } from "@composio/ao-core";

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "Runtime plugin: tmux sessions",
  version: "0.1.0",
};

export function create(): Runtime {
  return {
    name: "tmux",
    async create(config) {
      /* ... */
    },
    async destroy(handle) {
      /* ... */
    },
    // ... implement interface methods
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
```

**Do NOT** use `const plugin = { ... }; export default plugin;` — always inline `satisfies`.

## Shell Command Execution (MUST follow — security critical)

- **Always use `execFile`** (or `spawn`) — NEVER `exec` (shell injection risk)
- **Always add timeouts** — `{ timeout: 30_000 }` for external commands
- **Never interpolate user input** — pass as array args, not string template
- **Do NOT use `JSON.stringify` for shell escaping** — not a shell escaping function

```typescript
// GOOD
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { timeout: 30_000 });

// BAD — shell injection risk
exec(`git checkout ${branchName}`); // branchName could contain ; rm -rf /
```

## Error Handling

- Throw typed errors, don't return error codes
- Plugins throw if they can't do their job
- Core services catch and handle plugin errors
- **Always wrap `JSON.parse`** in try/catch (corrupted metadata should not crash)
- **Guard external data** — validate types from API/CLI/file inputs

## Naming

- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE` (only true constants: env vars, regex patterns)
- Test files: `*.test.ts` (co-located or in `__tests__/`)

## Commands

```bash
pnpm install           # install deps
pnpm build             # build all packages
pnpm typecheck         # typecheck
pnpm lint              # ESLint check
pnpm lint:fix          # ESLint auto-fix
pnpm format            # Prettier format
pnpm format:check      # Prettier check (CI)
pnpm test              # run tests

# Before committing
pnpm lint && pnpm typecheck

# Quick verification test (orchestrator setup)
./scripts/test-orchestrator-setup.sh  # 5-second end-to-end test
```

## Development Workflow

### Running the Dev Server

**IMPORTANT**: The web dashboard depends on built packages. Always build before running dev server.

```bash
# 1. Install dependencies (first time only)
pnpm install

# 2. Build all packages (required before dev server)
pnpm build

# 3. Ensure config exists
# Copy agent-orchestrator.yaml.example to agent-orchestrator.yaml and configure
cp agent-orchestrator.yaml.example agent-orchestrator.yaml

# 4. Run the dev server
cd packages/web
pnpm dev
```

**Why build first?** The web package imports from `@composio/ao-core` and plugin packages. These must be built (TypeScript compiled to JavaScript) before Next.js can resolve them.

**Config requirement**: The app expects `agent-orchestrator.yaml` in the working directory. Without it, all API routes will fail with "No agent-orchestrator.yaml found".

### Working with Worktrees

If using git worktrees (common for parallel agent work):

```bash
# After creating a worktree
cd /path/to/worktree
pnpm install          # Install deps
pnpm build            # Build packages
cp /path/to/main/agent-orchestrator.yaml .  # Copy config
cd packages/web && pnpm dev  # Start server
```

## Common Mistakes to Avoid

- Using `exec` instead of `execFile` — security vulnerability
- Using `JSON.stringify` for shell escaping — does not escape `$`, backticks, `$()`
- Missing `.js` extension in local imports — runtime error with ESM
- Using bare `"fs"` instead of `"node:fs"` — inconsistent
- Casting with `as unknown as T` — bypasses type safety, crashes on bad data
- `export default plugin` without `satisfies PluginModule<T>` — loses type checking
- Interpolating user input into shell commands, AppleScript, or GraphQL queries
- Forgetting to clean up setInterval/setTimeout on disconnect/destroy
- Using `on("exit")` instead of `once("exit")` for one-time handlers

## Config

Config loaded from `agent-orchestrator.yaml` (see `agent-orchestrator.yaml.example`). Paths support `~` expansion. Validated with Zod at load time. Per-project overrides for plugins and reactions.

## Design Decisions

1. **Stateless orchestrator** — no database, flat metadata files + event log
2. **Plugins implement interfaces** — pure implementation of interface from `types.ts`
3. **Push notifications** — Notifier is primary human interface, not dashboard
4. **Two-tier event handling** — auto-handle routine issues, notify human when judgment needed
5. **Backwards-compatible metadata** — flat key=value files
6. **Security first** — `execFile` not `exec`, validate all external input
