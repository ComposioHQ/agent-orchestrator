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
2. `packages/core/src/session-manager.ts` — session CRUD (spawn, kill, list, get, restore)
3. `packages/core/src/lifecycle-manager.ts` — state machine + reaction engine + event persistence
4. `agent-orchestrator.yaml.example` — config format
5. Plugin examples:
   - `packages/plugins/runtime-tmux/src/index.ts` — Runtime implementation
   - `packages/plugins/agent-claude-code/src/index.ts` — Agent implementation
6. This file (CLAUDE.md) — code conventions

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

# Logging & debugging (ao CLI)
ao logs dashboard [--since T] [--level L] [--tail N]   # query dashboard logs
ao logs events [--session S] [--type T]                # lifecycle event logs
ao perf routes                                         # API response times p50/p95/p99
ao perf slow [--limit N]                               # slowest requests with timing breakdown
ao perf cache                                          # cache hit rates
ao retro list [--project P]                            # session retrospectives
ao retro show <session>                                # view retrospective
ao dashboard restart [--clean] [--wait]                # restart dashboard (clean .next if needed)
ao dashboard status                                    # dashboard process status
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

## Using Playwright (MCP browser tool)

Before navigating with Playwright, kill any stale Chrome for Testing instance first — otherwise it fails silently with "Opening in existing browser session":

```bash
pkill -f "Google Chrome for Testing"
```

Then use `browser_navigate` as normal. If Playwright was previously used in the session it may have left an orphaned Chrome process.

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

## Logging & Observability

All system activity is logged to structured JSONL files for querying, debugging, and learning.

### Log Files

| File | Location | Content |
|------|----------|---------|
| `dashboard.jsonl` | `{logDir}/` | Dashboard stdout/stderr output |
| `events.jsonl` | `{logDir}/` | Lifecycle state transitions (session spawned, CI failed, PR merged, etc.) |
| `api.jsonl` | `{logDir}/` | API request timing with performance breakdowns |
| `browser.jsonl` | `{logDir}/` | Client-side errors, web vitals, fetch timing |

Log dir is at `~/.agent-orchestrator/{configHash}/{projectHash}/logs/`.

### Key Modules

| Module | Path | Purpose |
|--------|------|---------|
| `LogWriter` | `packages/core/src/log-writer.ts` | JSONL writer with size-based rotation |
| `readLogs` / `tailLogs` | `packages/core/src/log-reader.ts` | Query/filter log files |
| `generateReportCard` | `packages/core/src/session-report-card.ts` | Per-session metrics from event log |
| `generateRetrospective` | `packages/core/src/retrospective.ts` | Post-session analysis and lessons |
| `restartDashboard` | `packages/core/src/dashboard-manager.ts` | Programmatic dashboard process control |
| `request-logger` | `packages/web/src/lib/request-logger.ts` | API request timing |
| `client-logger` | `packages/web/src/lib/client-logger.ts` | Browser error/perf capture |
| `cache.getStats()` | `packages/web/src/lib/cache.ts` | Cache hit/miss tracking |

### LogEntry Format

Every JSONL line follows this schema:

```typescript
interface LogEntry {
  ts: string;       // ISO 8601
  level: "stdout" | "stderr" | "info" | "warn" | "error";
  source: "dashboard" | "lifecycle" | "cli" | "api" | "browser";
  sessionId: string | null;
  message: string;
  data?: Record<string, unknown>;
}
```

### Dashboard Pages

- `/logs` — filterable log viewer (source, level, time range, session)
- `/perf` — API performance dashboard (route stats, slow requests, cache hit rates, PR enrichment timing)

### Environment Variables (in spawned sessions)

- `AO_PROJECT_ID` — project identifier for this session
- `AO_LOG_DIR` — path to the project's log directory

### Debugging Tips for ao Development

- **Dashboard not loading?** `ao dashboard status` then `ao dashboard restart --clean --wait`
- **Slow API responses?** `ao perf routes` to find bottleneck, `ao perf slow` for details. PR enrichment in `packages/web/src/lib/serialize.ts` is the #1 bottleneck.
- **Lifecycle events missing?** Check `ao logs events --since 1h` and verify `logDir` is set in `LifecycleManagerDeps`
- **Session stuck?** `ao logs events --session <id>` to see state transitions, check if reaction fired

## Design Decisions

1. **Stateless orchestrator** — no database, flat metadata files + event log
2. **Plugins implement interfaces** — pure implementation of interface from `types.ts`
3. **Push notifications** — Notifier is primary human interface, not dashboard
4. **Two-tier event handling** — auto-handle routine issues, notify human when judgment needed
5. **Backwards-compatible metadata** — flat key=value files
6. **Security first** — `execFile` not `exec`, validate all external input
7. **Structured JSONL logging** — crash-safe append, size-based rotation, queryable
8. **Auto-retrospectives** — generated on session merge/kill for learning from past sessions
