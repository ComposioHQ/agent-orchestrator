# CLAUDE.md — Agent Orchestrator

## Quick Start

- **Adding a plugin?** → [Plugin Development](#plugin-development)
- **Modifying core types?** → Read `packages/core/src/types.ts` first, then [Architecture](#architecture-deep-dive)
- **First contribution?** → Read [What This Is](#what-this-is), [Key Files](#key-files), [Monorepo Tools](#monorepo-tools)

## What This Is

Open-source system for orchestrating parallel AI coding agents. Agent-agnostic (Claude Code, Codex, Aider), runtime-agnostic (tmux, docker, k8s), tracker-agnostic (GitHub, Linear, Jira). Manages session lifecycle, tracks PR/CI/review state, auto-handles routine issues (CI failures, review comments), pushes notifications to humans only when needed.

**Core principle: Push, not pull.** Spawn agents, walk away, get notified when your judgment is needed.

## Tech Stack

TypeScript (ESM), Node 20+, pnpm workspaces. Next.js 15 (App Router) + Tailwind. Commander.js CLI. YAML + Zod config. Server-Sent Events for real-time. Flat metadata files + JSONL event log. ESLint + Prettier. vitest.

## Architecture

8 plugin slots — every abstraction is swappable:

| Slot      | Interface   | Default Plugin | Purpose                           |
| --------- | ----------- | -------------- | --------------------------------- |
| Runtime   | `Runtime`   | tmux           | Where sessions execute            |
| Agent     | `Agent`     | claude-code    | AI coding tool adapter            |
| Workspace | `Workspace` | worktree       | Code isolation (worktree, clone)  |
| Tracker   | `Tracker`   | github         | Issue tracking (GitHub, Linear)   |
| SCM       | `SCM`       | github         | PR/CI/reviews                     |
| Notifier  | `Notifier`  | desktop        | Push notifications                |
| Terminal  | `Terminal`  | iterm2         | Human interaction UI              |
| Lifecycle | (core)      | —              | State machine + reactions (core)  |

**All interfaces defined in `packages/core/src/types.ts` — read this file first.**

## Key Files

1. **`packages/core/src/types.ts`** — source of truth for all interfaces
2. **`packages/core/src/services/session-manager.ts`** — session CRUD + spawn logic
3. **`packages/core/src/services/lifecycle-manager.ts`** — state machine + reactions
4. **`packages/core/src/services/plugin-registry.ts`** — plugin discovery + loading
5. **`agent-orchestrator.yaml.example`** — config format

## Looking for X?

| You want to...                     | Look here                                                    |
| ---------------------------------- | ------------------------------------------------------------ |
| Add a new plugin                   | `packages/plugins/`, follow `notifier-desktop` pattern       |
| Add a field to Session             | `packages/core/src/types.ts` → `Session` interface           |
| Add an event type                  | `packages/core/src/types.ts` → `EventType` union             |
| Modify spawn logic                 | `packages/core/src/services/session-manager.ts` → `spawn()`  |
| Modify state machine               | `packages/core/src/services/lifecycle-manager.ts`            |
| Add a CLI command                  | `packages/cli/src/commands/`                                 |
| Modify web dashboard               | `packages/web/src/`                                          |
| Add a reaction                     | `packages/core/src/services/lifecycle-manager.ts` → handlers |
| Test a plugin                      | `packages/plugins/<plugin>/src/__tests__/`                   |
| Modify config schema               | `packages/core/src/config.ts` → Zod schemas                  |

## Monorepo Tools

```bash
# Install all dependencies
pnpm install

# Build all packages
pnpm build

# Build one package (builds dependencies automatically)
pnpm --filter @agent-orchestrator/core build

# Run all tests
pnpm test

# Run tests in one package
pnpm --filter @agent-orchestrator/core test

# Run tests in watch mode
pnpm --filter @agent-orchestrator/core test -- --watch

# Add a dependency to a package
pnpm --filter @agent-orchestrator/core add <package-name>

# Lint all
pnpm lint

# Typecheck all
pnpm typecheck

# Before committing (MUST pass)
pnpm lint && pnpm typecheck
```

## Common Tasks

### Adding a New Plugin

1. **Create plugin directory**: `packages/plugins/<slot>-<name>/`
   ```bash
   mkdir -p packages/plugins/runtime-docker/src
   cd packages/plugins/runtime-docker
   ```

2. **Create package.json**:
   ```json
   {
     "name": "@agent-orchestrator/plugin-runtime-docker",
     "version": "0.1.0",
     "type": "module",
     "main": "./dist/index.js",
     "types": "./dist/index.d.ts",
     "scripts": {
       "build": "tsc",
       "typecheck": "tsc --noEmit"
     },
     "dependencies": {
       "@agent-orchestrator/core": "workspace:*"
     },
     "devDependencies": {
       "typescript": "^5.7.3"
     }
   }
   ```

3. **Create tsconfig.json** (copy from another plugin)

4. **Implement plugin** in `src/index.ts`:
   ```typescript
   import type { PluginModule, Runtime } from "@agent-orchestrator/core";

   export const manifest = {
     name: "docker",
     slot: "runtime" as const,
     description: "Runtime plugin: Docker containers",
     version: "0.1.0",
   };

   export function create(): Runtime {
     return {
       name: "docker",
       async create(config) { /* ... */ },
       async destroy(handle) { /* ... */ },
       async sendMessage(handle, message) { /* ... */ },
       async getOutput(handle, lines) { /* ... */ },
       async isAlive(handle) { /* ... */ },
     };
   }

   export default { manifest, create } satisfies PluginModule<Runtime>;
   ```

5. **Build and test**:
   ```bash
   pnpm --filter @agent-orchestrator/plugin-runtime-docker build
   pnpm --filter @agent-orchestrator/plugin-runtime-docker test
   ```

6. **Register in core** (if built-in): `packages/core/src/services/plugin-registry.ts` → `loadBuiltins()`

### Adding a Field to Session

1. **Update Session interface**: `packages/core/src/types.ts`
   ```typescript
   export interface Session {
     // ... existing fields
     newField: string | null;  // Add your field
   }
   ```

2. **Update SessionManager**: `packages/core/src/services/session-manager.ts`
   - Initialize the field in `spawn()`
   - Update metadata read/write if needed

3. **Update web dashboard** (if displayed): `packages/web/src/components/`

4. **Rebuild core**:
   ```bash
   pnpm --filter @agent-orchestrator/core build
   ```

### Adding an Event Type

1. **Add to EventType union**: `packages/core/src/types.ts`
   ```typescript
   export type EventType =
     | "session.spawned"
     // ... existing events
     | "your.new_event";  // Add here
   ```

2. **Emit the event**: In the relevant service, use `eventEmitter.emit()`

3. **Add reaction handler** (optional): `packages/core/src/services/lifecycle-manager.ts`

## Plugin Development

### The Plugin Pattern

Every plugin exports:
- **`manifest`** — metadata (name, slot, description, version)
- **`create()`** — factory function that returns the interface implementation
- **`default export`** — `{ manifest, create } satisfies PluginModule<T>`

**Why `satisfies`?** Compile-time type checking. Using `const plugin = { ... }; export default plugin;` loses type safety.

### Simplest Example: notifier-desktop

See `packages/plugins/notifier-desktop/src/index.ts` — ~150 lines, implements `Notifier` interface, uses `osascript` (macOS) or `notify-send` (Linux).

### Most Complete Example: agent-claude-code

See `packages/plugins/agent-claude-code/src/index.ts` — implements `Agent` interface, includes:
- Process detection (ps, TTY lookup)
- JSONL parsing (session info extraction)
- Activity classification (terminal output patterns)
- Post-launch setup (hook injection)

### Testing Plugins

1. **Create test file**: `packages/plugins/<plugin>/src/__tests__/index.test.ts`
2. **Mock dependencies**: Use vitest `vi.mock()` for `child_process`, `fs`, etc.
3. **Test edge cases**: timeouts, corrupted data, missing files, concurrent access

Example structure:
```typescript
import { describe, it, expect, vi } from "vitest";
import { create } from "../index.js";

describe("my-plugin", () => {
  it("should handle timeout", async () => {
    const plugin = create();
    // ... test timeout scenario
  });
});
```

## Architecture Deep Dive

### Data Flow: Spawn → Execute

```
CLI: ao spawn my-app issue-42
  ↓
SessionManager.spawn()
  ↓ reads config
  ↓ generates prompt via Tracker.generatePrompt()
  ↓
Workspace.create() → creates worktree/clone
  ↓
Agent.getLaunchCommand() → builds command
Agent.getEnvironment() → sets env vars
  ↓
Runtime.create() → starts session (tmux/docker/k8s)
  ↓ sends launch command
  ↓
Agent starts executing in workspace
  ↓
LifecycleManager polls → detects state changes
  ↓
Reactions trigger (CI failures, review comments)
  ↓
Notifier.notify() → pushes to human
```

### State Machine: Session Lifecycle

```
spawning
  ↓ agent starts
working
  ↓ PR created
pr_open
  ↓ CI fails → ci_failed (reaction: send fix prompt)
  ↓ CI passes + review pending → review_pending
  ↓ changes requested → changes_requested (reaction: send review comments)
  ↓ approved + CI passing → approved (reaction: notify human)
  ↓ ready to merge → mergeable (reaction: notify or auto-merge)
  ↓ merged
merged
  ↓ cleanup
(session killed)
```

### Key Abstractions

- **Session** — a running agent instance (state, metadata, runtime handle)
- **RuntimeHandle** — opaque handle to communicate with a session (tmux session name, container ID, pod name)
- **PluginModule** — what every plugin exports (`manifest` + `create()`)
- **OrchestratorEvent** — events emitted by lifecycle manager (session.spawned, pr.created, ci.failing, etc.)
- **ReactionConfig** — rules for auto-responding to events (send-to-agent, notify, auto-merge)

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

## Shell Command Execution (MUST follow — security critical)

**Always use `execFile` or `spawn`, NEVER `exec`**

### Why? exec is vulnerable to shell injection

**Exploit example:**
```typescript
// VULNERABLE
import { exec } from "node:child_process";
const branchName = "feat/add-feature; rm -rf /"; // malicious input
exec(`git checkout ${branchName}`); // executes: git checkout feat/add-feature; rm -rf /
```

**Safe:**
```typescript
// SAFE
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const branchName = "feat/add-feature; rm -rf /"; // malicious input
await execFileAsync("git", ["checkout", branchName], { timeout: 30_000 });
// git receives the string literally, no shell interpretation
```

**Rules:**
- **Always use `execFile`** (or `spawn`) — args as array, bypasses shell
- **Always add timeouts** — `{ timeout: 30_000 }` for external commands
- **Never interpolate user input** — pass as array args, not string template
- **Do NOT use `JSON.stringify` for shell escaping** — it doesn't escape `$`, backticks, `$()`

## Common Mistakes with Examples

### 1. Missing `.js` extension in imports

```typescript
// BAD — runtime error with ESM
import { foo } from "./bar";

// GOOD
import { foo } from "./bar.js";
```

**Why:** ESM requires explicit file extensions. Node won't auto-resolve.

### 2. Unsafe type casting

```typescript
// BAD — crashes on unexpected data
const data = JSON.parse(input) as MyType;
data.requiredField.toUpperCase(); // TypeError if field is missing

// GOOD — validate before using
const parsed: unknown = JSON.parse(input);
if (
  typeof parsed === "object" &&
  parsed !== null &&
  "requiredField" in parsed &&
  typeof parsed.requiredField === "string"
) {
  const data = parsed as MyType;
  data.requiredField.toUpperCase(); // safe
}
```

### 3. `export default plugin` without `satisfies`

```typescript
// BAD — loses type checking
const plugin = { manifest, create };
export default plugin; // no compile-time verification

// GOOD — compile-time type checking
export default { manifest, create } satisfies PluginModule<Runtime>;
```

### 4. Using `on("exit")` instead of `once("exit")`

```typescript
// BAD — handler called multiple times if event emits multiple times
process.on("exit", cleanup);

// GOOD — handler called once
process.once("exit", cleanup);
```

### 5. Forgetting cleanup on disconnect

```typescript
// BAD — interval keeps running after session dies
const interval = setInterval(poll, 1000);

// GOOD — cleanup on destroy
const interval = setInterval(poll, 1000);
return {
  // ... interface methods
  async destroy() {
    clearInterval(interval);
  },
};
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
- Test files: `*.test.ts` (co-located in `__tests__/`)

## Config

Config loaded from `agent-orchestrator.yaml` (see `agent-orchestrator.yaml.example`). Paths support `~` expansion. Validated with Zod at load time. Per-project overrides for plugins and reactions.

## Design Decisions (The "Why")

1. **Stateless orchestrator** — no database, flat metadata files + event log
   - **Why:** Debuggability (cat metadata file), no database dependency, survives crashes

2. **Plugins implement interfaces** — pure implementation of interface from `types.ts`
   - **Why:** Swappability (tmux → docker), testability (mock plugins), extensibility

3. **Push notifications** — Notifier is primary human interface, not dashboard
   - **Why:** Human doesn't poll. Spawn agents, walk away, get notified when needed.

4. **Two-tier event handling** — auto-handle routine issues (CI, reviews), notify human when judgment needed
   - **Why:** Reduce noise, scale to many agents, only interrupt human for decisions

5. **Flat key=value metadata files** — `branch=feat/foo` not JSON
   - **Why:** Backwards-compatible with bash scripts, easy to parse/debug

6. **Security first** — `execFile` not `exec`, validate all external input
   - **Why:** Orchestrator runs user-provided code. Shell injection is real threat.
