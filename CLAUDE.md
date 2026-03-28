# CLAUDE.md

## What is this project?

Agent Orchestrator (AO) is a platform for spawning and managing parallel AI coding agents across distributed systems. It runs multiple agents (Claude Code, Codex, Aider, OpenCode) simultaneously — each in an isolated git worktree with its own PR — and provides a single dashboard to supervise them all. Agents autonomously fix CI failures, address review comments, and manage PRs.

**Org:** ComposioHQ
**Repo:** `github.com/ComposioHQ/agent-orchestrator`
**License:** MIT

## Monorepo Structure

pnpm workspace (v9.15.4) with ~30 packages:

```
packages/
  core/           # Engine: types, config, session manager, lifecycle, plugin registry
  cli/            # CLI tool (`ao` command) — depends on all plugins
  web/            # Next.js 15 dashboard (App Router, React 19, Tailwind v4)
  ao/             # Global CLI wrapper (thin shim around cli)
  plugins/
    agent-claude-code/    agent-aider/    agent-codex/    agent-opencode/
    runtime-tmux/         runtime-process/
    workspace-worktree/   workspace-clone/
    tracker-github/       tracker-linear/   tracker-gitlab/
    scm-github/           scm-gitlab/
    notifier-desktop/     notifier-slack/   notifier-webhook/
    notifier-composio/    notifier-openclaw/
    terminal-iterm2/      terminal-web/
  integration-tests/      # E2E tests
```

**Build order:** core -> plugins -> cli/web (parallel). `pnpm build` at root handles this.

## Tech Stack

| Layer | Stack |
|-------|-------|
| Language | TypeScript (strict mode, ES2022, Node16 modules) |
| Runtime | Node.js 20+ |
| Package Manager | pnpm 9.15.4 (`workspace:*` protocol) |
| Web | Next.js 15 (App Router) + React 19 |
| Styling | Tailwind CSS v4 + CSS custom properties (`@theme` block in `globals.css`) |
| Terminal UI | xterm.js 5.3.0 + WebSocket to tmux PTYs |
| Validation | Zod |
| Testing | Vitest + @testing-library/react |
| Linting | ESLint 10 (flat config) + Prettier 3.8 |
| CI/CD | GitHub Actions (lint, typecheck, test, release) |
| Versioning | Changesets |
| Git hooks | Husky + gitleaks (secret scanning) |
| Container | OCI via Containerfile (Podman/Docker) |

## Commands

```bash
# Install & build
pnpm install
pnpm build

# Development
pnpm dev                                    # Web dashboard (Next.js + 2 WS servers)

# Type checking
pnpm typecheck                              # All packages
pnpm --filter @composio/ao-web typecheck    # Web only

# Testing
pnpm test                                   # All packages (excludes web)
pnpm --filter @composio/ao-web test         # Web tests
pnpm --filter @composio/ao-web test:watch   # Web watch mode
pnpm test:integration                       # Integration tests

# Lint & format
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
```

## Architecture

### Plugin System (8 Slots)

Every abstraction is a pluggable interface defined in `packages/core/src/types.ts`:

| Slot | Default | Purpose |
|------|---------|---------|
| Runtime | tmux | Where agents execute |
| Agent | claude-code | Which AI tool to use |
| Workspace | worktree | Code isolation (worktree vs clone) |
| Tracker | github | Issue tracking (GitHub, Linear, GitLab) |
| SCM | github | PR, CI, reviews |
| Notifier | desktop | Notification delivery |
| Terminal | iterm2 | Human attachment UI |
| Lifecycle | core (non-pluggable) | State machine + polling |

### Session Lifecycle

```
spawning -> working -> pr_open -> ci_failed / review_pending
                                      |              |
                              changes_requested   approved
                                      |              |
                                      +-> mergeable -> merged -> cleanup -> done
```

### Data Flow

```
agent-orchestrator.yaml -> Config Loader (Zod) -> Plugin Registry
  -> Session Manager -> Lifecycle Manager (polling loop, state machine)
  -> Events -> Notifiers
  -> Web API Routes (Next.js) -> SSE (5s interval) + WebSocket (terminal)
  -> Dashboard (React + xterm.js)
```

### Storage

No database. Flat files + memory:

- **Config:** `agent-orchestrator.yaml` (Zod-validated)
- **Session metadata:** `~/.agent-orchestrator/{hash}-{projectId}/sessions/{sessionId}` (key-value pairs)
- **Worktrees:** `~/.agent-orchestrator/{hash}-{projectId}/worktrees/{sessionId}/`
- **Archives:** `~/.agent-orchestrator/{hash}-{projectId}/archive/{sessionId}_{timestamp}`

Hash = SHA-256 of config directory (first 12 chars). Prevents collision across multiple checkouts.

### Prompt Assembly (3 Layers)

1. Base prompt (system instructions in core)
2. Config prompt (project-specific rules from YAML)
3. Rules files (optional `.agent-rules.md` from repo)

## Conventions

### Code Style

- **TypeScript strict mode** — no `any` types (`@typescript-eslint/no-explicit-any: error`)
- **Consistent type imports** — `import type { Foo }` enforced by ESLint
- **Immutable patterns** — spread operator, never mutate in place
- **Prefer const** — `no-var`, `prefer-const`
- **No eval** — `no-eval`, `no-implied-eval`, `no-new-func`
- **Unused vars** — prefix with `_` (`argsIgnorePattern: "^_"`)

### File Organization

- Components in flat `components/` directory (no nesting)
- Hooks in `hooks/` with `use` prefix
- Tests in `__tests__/` subdirectories
- No barrel files except `core/src/index.ts`
- Max 400 lines per component file

### Naming

- PascalCase for components/classes
- camelCase for functions/variables
- `use*` for hooks, `is*`/`has*` for booleans

### Imports

- `@/` alias -> `packages/web/src/`
- `@composio/ao-core` for core imports
- `workspace:*` for cross-package

### Web / Styling

- Tailwind utility classes only — **no inline `style=` attributes**
- CSS custom properties via `var(--color-*)` from `globals.css` `@theme` block
- Dark theme must always be preserved
- **No external UI component libraries** (no Radix, shadcn, etc.)
- Client components marked `"use client"`; server components for pages
- State: React hooks only (no Redux/Zustand)
- Real-time updates: SSE via `useSessionEvents` hook (5s interval, do not change)

### Testing

- Vitest + @testing-library/react
- Test files: `{Module}.test.ts` or `{Component}.test.tsx` in `__tests__/`
- Test files for all new components
- Relaxed lint in tests: `any` and `console.log` allowed

### Commits

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`
- Changesets for version management
- gitleaks pre-commit hook — never commit secrets

## Key Files

| File | Purpose |
|------|---------|
| `packages/core/src/types.ts` | Central type definitions (all 8 plugin interfaces) |
| `packages/core/src/session-manager.ts` | Session CRUD operations |
| `packages/core/src/lifecycle-manager.ts` | State machine + polling loop + reactions |
| `packages/core/src/config.ts` | YAML config loading with Zod validation |
| `packages/core/src/plugin-registry.ts` | Plugin discovery and resolution |
| `packages/core/src/index.ts` | Core public API (stable, do not break) |
| `packages/web/src/components/Dashboard.tsx` | Main dashboard view |
| `packages/web/src/components/SessionDetail.tsx` | Session detail view |
| `packages/web/src/components/DirectTerminal.tsx` | xterm.js terminal with WebSocket |
| `packages/web/src/components/SessionCard.tsx` | Kanban session card |
| `packages/web/src/hooks/useSessionEvents.ts` | SSE consumer hook |
| `packages/web/src/lib/types.ts` | Dashboard types |
| `packages/web/src/app/globals.css` | Design tokens and base styles |
| `agent-orchestrator.yaml` | Project-level config (user-created) |
| `eslint.config.js` | ESLint flat config |
| `tsconfig.base.json` | Shared TypeScript base config |

## Plugin Standards

### Package Layout

```
packages/plugins/{slot}-{name}/
├── package.json          # @composio/ao-plugin-{slot}-{name}
├── tsconfig.json         # extends ../../../tsconfig.base.json
├── src/
│   ├── index.ts          # manifest + create + detect (default export)
│   └── __tests__/        # vitest tests
```

### Naming

- Package: `@composio/ao-plugin-{slot}-{name}` (lowercase, hyphenated)
- `manifest.name` must match the `{name}` suffix (e.g. package `...-runtime-tmux` -> name: `"tmux"`)
- `manifest.slot` must use `as const` to preserve the literal type

### Export Contract

Every plugin default-exports a `PluginModule<T>`:

```typescript
import type { PluginModule, Runtime } from "@composio/ao-core";

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "tmux session runtime",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Runtime {
  // Validate config here, not in individual methods
  // Use closure to capture validated config
  return { ... };
}

// Optional: check if binary/dependency is available on system
export function detect(): boolean { ... }

export default { manifest, create, detect } satisfies PluginModule<Runtime>;
```

### Config Handling

- Plugin-level config comes via `create(config)` from the YAML notifier/tracker blocks
- Project-level config (e.g. `agentConfig`, `trackerConfig`) is passed to individual methods
- Validate in `create()`, store via closure — don't re-validate per call
- Warn (don't throw) for missing optional config during plugin load
- Throw with descriptive message when a required config is missing at method call time

### Error Handling

- Wrap errors with `cause` for debugging: `throw new Error("msg", { cause: err })`
- Return `null` for "not found" (e.g. tracker issue lookup), throw for unexpected errors
- Never silently swallow errors
- Use `shellEscape()` from core for all command arguments (prevent injection)

### Interface Implementation

- All I/O methods return `Promise<T>` (async-first)
- Plugins are loosely coupled — communicate through Session object and Lifecycle Manager, never call other plugins directly
- Implement `destroy()` / cleanup with best-effort semantics

### Core Utilities Available to Plugins

```typescript
import {
  shellEscape,            // Safe command argument escaping
  validateUrl,            // Webhook URL validation
  readLastJsonlEntry,     // Efficient JSONL log tail
  CI_STATUS, ACTIVITY_STATE, SESSION_STATUS,  // Constants
  type Session, type ProjectConfig, type RuntimeHandle,
} from "@composio/ao-core";
```

### Testing

- Vitest in `src/__tests__/index.test.ts`
- Mock external CLIs, file I/O, HTTP calls
- Test manifest values, `create()` return shape, all public methods, and error paths
- Use `beforeEach` to reset mocks

### Common Pitfalls

- Hardcoded secrets -> use `process.env`, throw if missing
- Shell injection -> use `shellEscape()` for all arguments
- Large file reads -> use streaming or `readLastJsonlEntry()`
- Config validation in methods -> validate once in `create()`, closure the rest

### Agent Plugin Implementation Standards

All agent plugins (claude-code, codex, aider, opencode, etc.) must implement the full `Agent` interface. The dashboard depends on these methods for PR tracking, cost display, and session resume.

**Required methods (all agents):**

| Method | Purpose | Return `null` OK? |
|--------|---------|-------------------|
| `getLaunchCommand` | Shell command to start the agent | No |
| `getEnvironment` | Env vars for agent process (must include `~/.ao/bin` in PATH) | No |
| `detectActivity` | Terminal output classification (deprecated, but required) | No |
| `getActivityState` | JSONL/API-based activity detection (min 3 states: active/ready/idle) | Yes (if no data) |
| `isProcessRunning` | Check process alive via tmux TTY or PID | No |
| `getSessionInfo` | Extract summary, cost, session ID from agent's data | Yes (if agent has no introspection) |

**Optional methods (implement when the agent supports it):**

| Method | Purpose | When to skip |
|--------|---------|-------------|
| `getRestoreCommand` | Resume a previous session | Agent has no resume capability (return `null`) |
| `setupWorkspaceHooks` | Install metadata-update hooks (PATH wrappers or agent-native) | Never — required for dashboard PR tracking |
| `postLaunchSetup` | Post-launch config (re-ensure hooks, resolve binary) | Only if no post-launch work needed |
| `recordActivity` | Write terminal-derived activity to JSONL for `getActivityState` | Agent has native JSONL (Claude Code, Codex) |

**Metadata hooks are critical.** Without `setupWorkspaceHooks`, PRs created by agents won't appear in the dashboard. Two patterns exist:
- **Agent-native hooks** (Claude Code): PostToolUse hooks in `.claude/settings.json`
- **PATH wrappers** (Codex, Aider, OpenCode): `~/.ao/bin/gh` and `~/.ao/bin/git` intercept commands

**Environment requirements:**
- All agents must set `AO_SESSION_ID` and optionally `AO_ISSUE_ID`
- All agents using PATH wrappers must prepend `~/.ao/bin` to PATH
- Use `normalizeAgentPermissionMode` from `@composio/ao-core` (not a local duplicate)

**Activity detection architecture:**
- Agents with native JSONL (Claude Code, Codex) read their own session files in `getActivityState`
- Agents without native JSONL (Aider, OpenCode) implement `recordActivity` — the lifecycle manager calls it each poll cycle with terminal output, writing to `{workspacePath}/.ao/activity.jsonl`
- `getActivityState` then reads from that JSONL file, enabling `waiting_input`/`blocked` detection
- Use `appendActivityEntry()` and `readLastActivityEntry()` from `@composio/ao-core`

**`isProcessRunning` must:**
- Support tmux runtime (TTY-based `ps` lookup with process name regex)
- Support process runtime (PID signal-0 check with EPERM handling)
- Return `false` (not `null`) on error

## Constraints

- C-01: No new UI component libraries
- C-02: No inline styles in new/modified code
- C-04: Component files max 400 lines
- C-05: Dark theme preserved (no redesign)
- C-06: Next.js App Router only
- C-07: No animation libraries
- C-12: Test files for all new components
- C-13: pnpm `workspace:*` protocol for cross-package deps
- C-14: SSE 5s interval unchanged
