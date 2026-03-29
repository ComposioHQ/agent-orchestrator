# @composio/ao-web

## 0.2.2

### Patch Changes

- 5315e4e: Fix runtime terminal websocket connectivity for npm-installed/prebuilt runs and harden project validation across API routes.
  - add runtime terminal config endpoint (`/api/runtime/terminal`) so the browser can read runtime-selected ports
  - make direct terminal client resolve websocket target from runtime config before connect/reconnect
  - add AbortController (1.5s) to runtime config fetch so a slow endpoint cannot block WebSocket connection
  - prevent repeated runtime config fetches on reconnect when the endpoint is unavailable
  - centralize project existence check via `validateConfiguredProject` (uses `Object.hasOwn` to avoid prototype-chain bypass)
  - apply semantic project validation to `/api/spawn`, `/api/issues`, `/api/verify`, and `/api/orchestrators`
  - return deterministic `404 Unknown project` from all routes for non-configured project IDs
  - normalize dashboard project filter to configured project IDs to prevent invalid query state propagation

## 0.2.0

### Minor Changes

- 3a650b0: Zero-friction onboarding: `ao start` auto-detects project, generates config, and launches dashboard — no prompts, no manual setup. Renamed npm package to `@composio/ao`. Made `@composio/ao-web` publishable with production entry point. Cross-platform agent detection. Auto-port-finding. Permission auto-retry in shell scripts.

### Patch Changes

- Updated dependencies [3a650b0]
  - @composio/ao-core@0.2.0
  - @composio/ao-plugin-agent-claude-code@0.2.0
  - @composio/ao-plugin-agent-opencode@0.2.0
  - @composio/ao-plugin-runtime-tmux@0.2.0
  - @composio/ao-plugin-scm-github@0.2.0
  - @composio/ao-plugin-tracker-github@0.2.0
  - @composio/ao-plugin-tracker-linear@0.2.0
  - @composio/ao-plugin-workspace-worktree@0.2.0
