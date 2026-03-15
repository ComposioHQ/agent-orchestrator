# Agent Orchestrator Structure

## Top-Level Layout

- `package.json` is the monorepo root manifest.
- `pnpm-workspace.yaml` includes `packages/*` and `packages/plugins/*`, while explicitly excluding `packages/mobile` from the workspace build graph.
- `packages/` contains application packages plus the shared core.
- `packages/plugins/` contains one package per integration adapter.
- `scripts/` contains shell helpers for setup, spawning, tmux workflows, status, dashboard launch, and maintenance.
- `examples/` contains sample `agent-orchestrator.yaml` configurations.
- `tests/integration/` contains Docker-based and shell-based integration harness files.
- `docs/`, `artifacts/`, and the root `ARCHITECTURE.md` hold design and operational reference material outside the executable code path.

## Key Package Locations

- Core domain logic: `packages/core/src/`.
- CLI command implementation: `packages/cli/src/commands/`.
- CLI supporting utilities: `packages/cli/src/lib/`.
- Web dashboard app routes: `packages/web/src/app/`.
- Web dashboard components: `packages/web/src/components/`.
- Web server-side helpers: `packages/web/src/lib/`.
- Web terminal sidecar servers: `packages/web/server/`.
- Mobile client screens and context: `packages/mobile/src/`.
- Plugin implementations: `packages/plugins/*/src/index.ts`.
- Integration tests: `packages/integration-tests/src/`.

## Where Backend Logic Lives

- Session lifecycle and orchestration backend logic lives primarily in `packages/core/src/session-manager.ts` and `packages/core/src/lifecycle-manager.ts`.
- Config parsing and validation live in `packages/core/src/config.ts`.
- File-backed metadata persistence lives in `packages/core/src/metadata.ts`.
- Hash-based runtime path generation lives in `packages/core/src/paths.ts`.
- Web backend endpoints live in `packages/web/src/app/api/**/route.ts`.
- Web service bootstrapping lives in `packages/web/src/lib/services.ts`.
- Terminal transport backends live in `packages/web/server/terminal-websocket.ts` and `packages/web/server/direct-terminal-ws.ts`.

## Where Dashboard Logic Lives

- Main page shell: `packages/web/src/app/page.tsx`.
- Session detail page: `packages/web/src/app/sessions/[id]/page.tsx`.
- Main UI composition: `packages/web/src/components/Dashboard.tsx`.
- Session-specific UI: `packages/web/src/components/SessionCard.tsx`, `packages/web/src/components/SessionDetail.tsx`, `packages/web/src/components/Terminal.tsx`, and `packages/web/src/components/DirectTerminal.tsx`.
- Project navigation UI: `packages/web/src/components/ProjectSidebar.tsx`.
- Session event streaming hook: `packages/web/src/hooks/useSessionEvents.ts`.
- Serialization, formatting, project filtering, caching, and API-facing types live under `packages/web/src/lib/`.

## Where Plugin Logic Lives

- Agent adapters: `packages/plugins/agent-aider/`, `packages/plugins/agent-claude-code/`, `packages/plugins/agent-codex/`, and `packages/plugins/agent-opencode/`.
- Runtime adapters: `packages/plugins/runtime-process/` and `packages/plugins/runtime-tmux/`.
- Workspace adapters: `packages/plugins/workspace-clone/` and `packages/plugins/workspace-worktree/`.
- Tracker adapters: `packages/plugins/tracker-github/`, `packages/plugins/tracker-gitlab/`, and `packages/plugins/tracker-linear/`.
- SCM adapters: `packages/plugins/scm-github/` and `packages/plugins/scm-gitlab/`.
- Notifier adapters: `packages/plugins/notifier-composio/`, `packages/plugins/notifier-desktop/`, `packages/plugins/notifier-openclaw/`, `packages/plugins/notifier-slack/`, and `packages/plugins/notifier-webhook/`.
- Terminal adapters: `packages/plugins/terminal-iterm2/` and `packages/plugins/terminal-web/`.
- The standard implementation file is `src/index.ts`; tests usually sit in `src/index.test.ts`, `src/__tests__/`, or `test/`.

## Naming Conventions

- Package names follow the `@composio/ao-*` prefix.
- Plugin packages use `@composio/ao-plugin-<slot>-<name>` naming at the package level and `packages/plugins/<slot>-<name>/` on disk.
- Plugin registry keys use the form `slot:name`, as implemented in `packages/core/src/plugin-registry.ts`.
- Route handlers follow Next App Router naming with `route.ts` under `packages/web/src/app/api/...`.
- React app routes follow folder-based route naming under `packages/web/src/app/`.
- Core source files are noun-oriented and responsibility-oriented, such as `config.ts`, `session-manager.ts`, `lifecycle-manager.ts`, and `plugin-registry.ts`.
- Tests are colocated and usually named `*.test.ts`, `*.test.tsx`, or `*.integration.test.ts`.

## API Surface Layout

- Session APIs: `packages/web/src/app/api/sessions/route.ts` and `packages/web/src/app/api/sessions/[id]/*`.
- Spawn and verify APIs: `packages/web/src/app/api/spawn/route.ts` and `packages/web/src/app/api/verify/route.ts`.
- Project and issue APIs: `packages/web/src/app/api/projects/route.ts` and `packages/web/src/app/api/issues/route.ts`.
- Event and observability APIs: `packages/web/src/app/api/events/route.ts` and `packages/web/src/app/api/observability/route.ts`.
- SCM webhook ingress: `packages/web/src/app/api/webhooks/[...slug]/route.ts`.

## Practical Navigation Tips

- For orchestration behavior, start in `packages/core/src/`.
- For CLI behavior, move from `packages/cli/src/index.ts` into the relevant file in `packages/cli/src/commands/`.
- For dashboard behavior, move from `packages/web/src/app/page.tsx` to `packages/web/src/lib/services.ts`, then into the matching component under `packages/web/src/components/`.
- For a specific integration, open the relevant package under `packages/plugins/` and start with `src/index.ts`.
- For real-world behavior verification, check `packages/integration-tests/src/` before assuming a plugin or flow is unused.
