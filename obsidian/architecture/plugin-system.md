---
tags: [architecture, plugins, agent-orchestrator]
created: 2026-03-04
updated: 2026-03-04
---

# Plugin System

Every abstraction in Agent Orchestrator is swappable through 8 plugin slots. Each plugin implements a TypeScript interface and exports a `PluginModule`.

## 8 Plugin Slots

| Slot | Interface | Default Plugin | Alternatives |
|------|-----------|----------------|--------------|
| Runtime | `Runtime` | tmux | docker, k8s, process |
| Agent | `Agent` | claude-code | codex, aider, opencode |
| Workspace | `Workspace` | worktree | clone |
| Tracker | `Tracker` | github | linear |
| SCM | `SCM` | github | -- |
| Notifier | `Notifier` | desktop | slack, composio, webhook |
| Terminal | `Terminal` | iterm2 | web |
| Lifecycle | (core) | -- | -- |

## Plugin Pattern

Every plugin exports a `PluginModule` with an inline `satisfies` for compile-time type checking:

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
    async create(config) { /* ... */ },
    async destroy(handle) { /* ... */ },
    // ... implement interface methods
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
```

**Rules:**
- Always use inline `satisfies PluginModule<T>` -- never `const plugin = { ... }; export default plugin;`
- Each plugin has its own package under `packages/plugins/` (e.g., `runtime-tmux`, `agent-claude-code`)
- Plugins throw if they cannot do their job; core services catch and handle plugin errors

## Plugin Directory Layout

```
packages/plugins/
  runtime-{tmux,process}/
  agent-{claude-code,codex,aider,opencode}/
  workspace-{worktree,clone}/
  tracker-{github,linear}/
  scm-github/
  notifier-{desktop,slack,composio,webhook}/
  terminal-{iterm2,web}/
```

## Key File

**`packages/core/src/types.ts`** -- All plugin interfaces are defined here. Read this file first when working on any plugin.

## Related

- [[overview]] -- System design and data flow
- [[cli-and-web]] -- CLI commands and web dashboard
