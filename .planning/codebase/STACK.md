# Agent Orchestrator Stack

## Repository shape
- Root package metadata lives in `package.json`.
- PNPM workspace membership is declared in `pnpm-workspace.yaml`.
- Shared TypeScript compiler defaults live in `tsconfig.base.json`.
- The monorepo is package-oriented under `packages/` and `packages/plugins/`.
- `packages/mobile` exists in-repo but is explicitly excluded from the PNPM workspace by `pnpm-workspace.yaml`.
- `.planning/codebase/` is documentation output only; runtime code lives under `packages/`.

## Languages and runtimes
- Primary implementation language: TypeScript in `packages/core/src`, `packages/cli/src`, `packages/web/src`, and all plugin `src/` directories.
- JavaScript config/runtime glue appears in `eslint.config.js`, `packages/mobile/babel.config.js`, `packages/mobile/metro.config.js`, and `packages/agent-orchestrator/bin/ao.js`.
- Shell tooling exists in `scripts/` and integration helpers such as `tests/integration/run-test.sh`.
- Node.js is the main runtime; root `package.json` and package manifests require `node >=20.0.0`.
- The repository is ESM-first: root and most packages set `"type": "module"` in their `package.json`.
- React Native / Expo is used for the mobile app in `packages/mobile/package.json`.

## TypeScript baseline
- Common TS target is ES2022 from `tsconfig.base.json`.
- Module format is `Node16` with `moduleResolution: Node16` in `tsconfig.base.json`.
- Strict typing is enabled in `tsconfig.base.json` via `"strict": true`.
- Shared compiler output conventions are `outDir: "dist"` and `rootDir: "src"` in `tsconfig.base.json`.
- Package builds are plain `tsc` or `tsc -p ...`; there is no Turborepo or Nx config in the repo root.

## Top-level packages
- Core library: `packages/core` published as `@composio/ao-core`.
- CLI: `packages/cli` published as `@composio/ao-cli`.
- Web dashboard: `packages/web` published privately as `@composio/ao-web`.
- Mobile app: `packages/mobile` published privately as `@composio/ao-mobile`.
- Integration test harness: `packages/integration-tests`.
- Global wrapper package: `packages/agent-orchestrator` exposing the `ao` bin.

## Plugin package structure
- Agent plugins live in `packages/plugins/agent-*`.
- Runtime plugins live in `packages/plugins/runtime-*`.
- Workspace plugins live in `packages/plugins/workspace-*`.
- Tracker plugins live in `packages/plugins/tracker-*`.
- SCM plugins live in `packages/plugins/scm-*`.
- Notifier plugins live in `packages/plugins/notifier-*`.
- Terminal plugins live in `packages/plugins/terminal-*`.
- Built-in plugin registration is hard-coded in `packages/core/src/plugin-registry.ts`.

## Core dependencies
- `packages/core/package.json` depends on `yaml` for config parsing.
- `packages/core/package.json` depends on `zod` for config/schema validation.
- `packages/core/package.json` depends on `@anthropic-ai/sdk`; decomposer defaults in `packages/core/src/config.ts` also reference Anthropic model names.

## CLI stack
- `packages/cli/package.json` uses `commander` for command parsing.
- `packages/cli/package.json` uses `chalk` and `ora` for terminal UX.
- `packages/cli/package.json` uses `tsx` for local dev execution.
- The CLI imports workspace plugin packages directly rather than resolving them dynamically; see `packages/cli/src/lib/plugins.ts` and `packages/cli/src/lib/create-session-manager.ts`.

## Web stack
- `packages/web/package.json` uses Next.js 15.1 with React 19.
- The app router lives under `packages/web/src/app/`.
- Shared dashboard services are initialized in `packages/web/src/lib/services.ts`.
- Terminal support uses `ws`, `node-pty`, `xterm`, `@xterm/addon-fit`, and `@xterm/addon-web-links`.
- Tailwind CSS v4 is configured via `packages/web/postcss.config.mjs`.
- Next.js config lives in `packages/web/next.config.js`.
- Direct terminal and ttyd companion servers live in `packages/web/server/direct-terminal-ws.ts` and `packages/web/server/terminal-websocket.ts`.

## Mobile stack
- Expo app metadata lives in `packages/mobile/app.json`.
- Expo build profiles live in `packages/mobile/eas.json`.
- Navigation uses `@react-navigation/native` and `@react-navigation/native-stack` from `packages/mobile/package.json`.
- Notifications/background polling use `expo-notifications`, `expo-background-task`, and `expo-task-manager`.
- Persistent mobile settings use `@react-native-async-storage/async-storage`.

## Testing
- Unit/integration test runner across packages is Vitest.
- Package-level Vitest configs are in `packages/core/vitest.config.ts`, `packages/cli/vitest.config.ts`, `packages/web/vitest.config.ts`, and `packages/integration-tests/vitest.config.ts`.
- Web component/API tests use `@testing-library/react`, `@testing-library/jest-dom`, and `jsdom` from `packages/web/package.json`.
- Browser screenshot tooling uses Playwright from `packages/web/package.json` and `packages/web/e2e/`.
- Docker-based integration test fixtures live in `tests/integration/Dockerfile` and `tests/integration/docker-compose.yml`.

## Linting, formatting, release, and hooks
- ESLint config is centralized in `eslint.config.js`.
- Prettier is configured via dependency usage from root `package.json`; there is no dedicated `.prettierrc` in the file list inspected.
- Husky is installed from the root `prepare` script in `package.json`.
- Changesets release tooling is wired in root `package.json` via `changeset`, `version-packages`, and `release`.

## Build and dev commands
- Root `package.json` runs recursive builds with `pnpm -r build`.
- Root `package.json` runs recursive type checks with `pnpm -r typecheck`.
- Root `package.json` excludes `@composio/ao-web` from the default test command.
- Root `package.json` triggers `scripts/rebuild-node-pty.js` on `postinstall`.
- Web local dev uses concurrent processes from `packages/web/package.json` to run Next plus terminal websocket servers.
- CLI update/doctor commands delegate to shell scripts in `scripts/ao-update.sh` and `scripts/ao-doctor.sh`.

## Config sources
- Main user config is YAML loaded from `agent-orchestrator.yaml` or `agent-orchestrator.yml`; see `packages/core/src/config.ts`.
- Config resolution checks `AO_CONFIG_PATH` first in `packages/core/src/config.ts`.
- Fallback config search climbs from CWD, then checks home paths like `~/.agent-orchestrator.yaml` and `~/.config/agent-orchestrator/config.yaml`.
- Example config sources live in `agent-orchestrator.yaml.example`, `examples/simple-github.yaml`, `examples/linear-team.yaml`, `examples/codex-integration.yaml`, and `examples/multi-project.yaml`.
- Dashboard runtime env vars are assembled in `packages/cli/src/lib/web-dir.ts` and consumed by the web package through `NEXT_PUBLIC_TERMINAL_PORT`, `NEXT_PUBLIC_DIRECT_TERMINAL_PORT`, and related values.

## Operational defaults encoded in code
- Default runtime/agent/workspace/notifier values are defined in `packages/core/src/config.ts`.
- Default reaction automation is defined in `packages/core/src/config.ts` with events such as `ci-failed`, `changes-requested`, and `approved-and-green`.
- Session manager, lifecycle manager, metadata, observability, and prompt generation all live in `packages/core/src/`.
