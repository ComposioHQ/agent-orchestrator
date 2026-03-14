# Testing Reference

## Test Stack
- The repo standard is Vitest for TypeScript packages. Active configs live in `packages/cli/vitest.config.ts`, `packages/core/vitest.config.ts`, `packages/web/vitest.config.ts`, and `packages/integration-tests/vitest.config.ts`.
- `packages/web` runs Vitest with `jsdom`, React support from `@vitejs/plugin-react`, and Testing Library setup from `packages/web/src/__tests__/setup.ts`.
- `packages/cli`, `packages/core`, and most plugin packages run Node-oriented Vitest suites.
- There is also a Docker-based shell integration harness under `tests/integration`, driven by `tests/integration/run-test.sh`.

## File Organization
- CLI unit and command tests live in `packages/cli/__tests__/commands/*.test.ts`.
- Core tests live in `packages/core/__tests__/*.test.ts`.
- Web tests live under `packages/web/src/__tests__` and can also sit next to server code with names like `server/**/*.test.ts`, per `packages/web/vitest.config.ts`.
- Plugin tests are usually local to the plugin source, for example `packages/plugins/notifier-slack/src/index.test.ts`.
- Full integration scenarios live in `packages/integration-tests/src/*.integration.test.ts`.
- Legacy onboarding coverage using Docker lives in `tests/integration/onboarding-test.sh` and related files in `tests/integration`.

## How To Choose Test Scope
- Write a unit test when the logic can be isolated behind a function, module, or component boundary with mocks.
- Write a web route or component test when behavior depends on Next request handling, DOM rendering, or client interaction, but does not need real external services.
- Write an integration test when the value comes from exercising real plugins, tmux sessions, worktrees, or cross-package orchestration.
- Prefer the narrowest test that proves the behavior. The integration suite is slower and expects more host tooling.

## Mocking Patterns
- Use `vi.mock()` for module replacement and `vi.hoisted()` when mocks must exist before imports are evaluated. `packages/cli/__tests__/commands/spawn.test.ts` is the main reference.
- Use `vi.spyOn()` for targeted behavior changes on `console`, `process`, or module methods that should retain most of their real implementation.
- Use `vi.stubGlobal()` for globals such as `fetch`, as shown in `packages/plugins/notifier-slack/src/index.test.ts`.
- Reset or restore mocks in `beforeEach` or `afterEach`; common patterns are `vi.clearAllMocks()`, `vi.restoreAllMocks()`, and `vi.unstubAllGlobals()`.
- In web tests, mock service boundaries like `@/lib/services` rather than recreating the entire app bootstrap path.

## Web Testing Patterns
- `packages/web/src/__tests__/setup.ts` imports `@testing-library/jest-dom/vitest`, so DOM assertions like `toBeInTheDocument` are available.
- Route handler tests instantiate `NextRequest` directly and call exported `GET` or `POST` functions, as in `packages/web/src/__tests__/api-routes.test.ts`.
- Prefer mocking the service layer and plugin registry instead of hitting the filesystem or real trackers from web tests.
- Keep API assertions explicit on HTTP status and JSON payload shape.

## Integration Test Patterns
- `packages/integration-tests/vitest.config.ts` only includes `src/**/*.integration.test.ts` and raises timeouts because the suite shells out to real tools.
- Integration helpers live in `packages/integration-tests/src/helpers`, including tmux session setup, polling, and event factories.
- Gate environment-dependent tests with prerequisite checks and `describe.skipIf(...)`, as in `packages/integration-tests/src/agent-codex.integration.test.ts`.
- Clean up temp directories, sessions, and processes in `afterAll` hooks even when tests fail.
- Use polling helpers for asynchronous state transitions instead of arbitrary sleeps when possible.

## Commands
- Run the main repo test suite with `pnpm test` from the repo root. The root script skips `@composio/ao-web`, so it primarily covers workspace packages outside the Next app.
- Run integration tests with `pnpm test:integration` from the repo root.
- Run a specific package suite with `pnpm --filter @composio/ao-cli test`, `pnpm --filter @composio/ao-core test`, or `pnpm --filter @composio/ao-web test`.
- Run the web suite in watch mode with `pnpm --filter @composio/ao-web test:watch`.
- Check type safety and lint alongside tests with `pnpm typecheck` and `pnpm lint`.
- Run the Docker onboarding harness with `bash tests/integration/run-test.sh` when you specifically need that older end-to-end flow.

## Current Config Details
- `packages/cli/vitest.config.ts` uses a `threads` pool with `minThreads: 1` and `maxThreads: 8`.
- `packages/integration-tests/vitest.config.ts` uses a `forks` pool and long `testTimeout` and `hookTimeout` values.
- `packages/core/vitest.config.ts` aliases plugin packages back to source files so integration-style core tests can import real implementations without circular dev dependencies.
- `packages/web/vitest.config.ts` includes `src/**/*.test.{ts,tsx}` and `server/**/*.test.ts`, with alias `@` resolving to `packages/web/src`.

## Practical Defaults For New Tests
- If you change CLI command behavior, add or update a file under `packages/cli/__tests__/commands`.
- If you change Zod schemas, path utilities, or lifecycle logic, add package-local tests under `packages/core/__tests__`.
- If you change a web route, add a route handler test near `packages/web/src/__tests__/api-routes.test.ts` or split a focused file under `packages/web/src/__tests__`.
- If you change a plugin contract or formatting behavior, prefer a plugin-local test file next to `src/index.ts`.
- If the change only fails when real tmux, git, Codex, or workspace behavior is exercised, add an integration test under `packages/integration-tests/src`.

## Gaps And Caveats
- `packages/mobile` currently has no visible dedicated test config in this repo snapshot, so mobile changes need extra manual verification unless a new test harness is introduced.
- Because the root `pnpm test` excludes `@composio/ao-web`, web changes require an explicit `pnpm --filter @composio/ao-web test`.
- Some integration coverage depends on local binaries, environment variables, or services; document prerequisites in the test file header when you add a new host-dependent scenario.
