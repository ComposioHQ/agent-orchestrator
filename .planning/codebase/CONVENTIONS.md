# Code Conventions

## Scope
- This repo is a pnpm monorepo rooted at `package.json` with active packages under `packages/core`, `packages/cli`, `packages/web`, `packages/plugins/*`, `packages/integration-tests`, and a separately managed Expo app in `packages/mobile`.
- Shared TypeScript defaults live in `tsconfig.base.json`; lint and formatting rules live in `eslint.config.js` and `.prettierrc`.
- Use these conventions for new code unless a package already has a stronger local pattern.

## Formatting And Baseline Style
- Prettier is the source of truth: semicolons on, double quotes, trailing commas `all`, 2-space indentation, `printWidth` 100, and arrow parens always.
- ESLint uses `@eslint/js`, `typescript-eslint` strict mode, and `eslint-config-prettier` in `eslint.config.js`.
- Prefer small functions with explicit return types where the intent is not obvious.
- Use line comments sparingly; current code prefers short section comments or docblocks only where behavior is non-obvious, for example in `packages/web/src/lib/services.ts`.

## TypeScript Patterns
- All workspace packages are ESM (`"type": "module"` in package manifests). In Node packages, local imports use explicit `.js` extensions, for example `packages/core/src/config.ts` imports `./types.js`.
- Prefer `import type` for type-only imports. ESLint enforces this via `@typescript-eslint/consistent-type-imports`.
- Do not introduce `any`. The lint config blocks it outside tests. Use `unknown`, narrow aggressively, and validate external input.
- Shared runtime and config validation uses Zod in `packages/core/src/config.ts`; extend schemas there instead of sprinkling unchecked object access elsewhere.
- Keep strict-null behavior visible. Non-null assertions are only a warning, not a pattern to rely on.
- Use Node builtins via the `node:` prefix in server and CLI code, as seen in `packages/cli/src/commands/dashboard.ts` and `packages/core/src/config.ts`.

## Imports And Module Boundaries
- Order imports by responsibility: builtins, external packages, workspace aliases, then relative imports. Existing files usually separate groups with blank lines.
- In `packages/web`, use the `@/*` alias from `packages/web/tsconfig.json` for app-local imports such as `@/lib/services`.
- In Node-side packages, prefer explicit relative imports or workspace package imports such as `@composio/ao-core`.
- Do not bypass package boundaries by importing from another package's internal `src` files in production code. The one common exception is test-time aliasing in `packages/core/vitest.config.ts`.

## Naming
- Use PascalCase for React components and component file names, for example `packages/web/src/components/ProjectSidebar.tsx` and `packages/mobile/src/components/SessionCard.tsx`.
- Use camelCase for functions, helpers, hooks, and variables, for example `getServices`, `validateString`, `useSessionNotifications`, and `findRunningDashboardPid`.
- Use SCREAMING_SNAKE_CASE for module constants that are effectively configuration, for example `BACKLOG_POLL_INTERVAL` in `packages/web/src/lib/services.ts`.
- Test files follow `*.test.ts`, `*.test.tsx`, or `*.integration.test.ts` depending on scope.

## React And Next.js Patterns
- `packages/web` is an active Next.js 15 app with App Router under `packages/web/src/app`; route handlers use `NextRequest` and `NextResponse`, as in `packages/web/src/app/api/issues/route.ts`.
- Client components start with `"use client"` and keep UI state local. Examples live in `packages/web/src/components/ProjectSidebar.tsx` and `packages/web/src/components/SessionCard.tsx`.
- Prefer small presentational components plus focused helpers from `packages/web/src/lib/*` rather than embedding formatting or validation logic directly in JSX.
- When server state must survive Next HMR in development, cache it intentionally on `globalThis`, following the singleton pattern in `packages/web/src/lib/services.ts`.
- Use the web alias `@/` inside `packages/web`; do not use that alias outside the web package.
- `packages/mobile` is React Native and Expo, not Next.js. Reuse React naming and state-management conventions there, but do not copy web-only APIs like `next/navigation`.

## Error Handling
- Validate user and request input early, then return precise errors. Route handlers in `packages/web/src/app/api/issues/route.ts` use 400 for malformed input, 404 for missing resources, 422 for unsupported capabilities, and 500 for unexpected failures.
- For external systems, wrap the narrowest possible call in `try/catch` so partial failures can be tolerated when appropriate. `packages/web/src/lib/services.ts` skips unavailable trackers but still returns other results.
- Normalize unknown errors with `err instanceof Error ? err.message : "fallback message"`.
- Do not swallow errors silently unless the code is intentionally best-effort and the fallback behavior is explicit in comments.
- In CLI code, prefer human-readable stderr plus a controlled process exit, as in `packages/cli/src/commands/dashboard.ts`.

## Shelling Out And Security
- Use `spawn` or `execFile` with argument arrays. Avoid shell interpolation. Existing guidance in `docs/DEVELOPMENT.md` matches the implementation style in `packages/cli/src/commands/dashboard.ts`.
- Set timeouts on subprocesses where hanging is plausible.
- Treat paths, branch names, issue IDs, and other user-controlled values as untrusted input.
- `no-eval`, `no-implied-eval`, and `no-new-func` are hard errors in `eslint.config.js`; keep it that way.

## Testing Conventions
- Co-locate unit tests with the package they verify: `packages/core/__tests__`, `packages/cli/__tests__`, `packages/web/src/__tests__`, and package-local tests like `packages/plugins/notifier-slack/src/index.test.ts`.
- Use Vitest across the TypeScript packages. Relaxed lint rules for tests are configured in `eslint.config.js`, but production typing standards still apply where practical.
- Prefer explicit mock factories and `vi.hoisted` when import-time mocking matters, as in `packages/cli/__tests__/commands/spawn.test.ts`.
- Keep integration tests clearly named `*.integration.test.ts` under `packages/integration-tests/src`.
- When a behavior depends on real external tools like tmux, Codex, or Docker, gate the test with prerequisite checks instead of making the suite flaky, as in `packages/integration-tests/src/agent-codex.integration.test.ts`.

## Package-Specific Notes
- `packages/cli` is allowed to use `console` for user-facing output; ESLint explicitly permits it there.
- `packages/mobile` is excluded from the root ESLint config in `eslint.config.js`, so changes there should follow the established local style manually until dedicated tooling is added.
- `packages/web` excludes test files from the main TypeScript compile in `packages/web/tsconfig.json`; keep tests in `src/**/__tests__` or `src/**/*.test.tsx` rather than mixing them into production entrypoints.

## Practical Default
- If you are adding new backend or CLI code, start from patterns in `packages/core/src/config.ts` or `packages/cli/src/commands/dashboard.ts`.
- If you are adding new Next.js API or UI code, start from `packages/web/src/app/api/issues/route.ts` and `packages/web/src/components/ProjectSidebar.tsx`.
- If you are adding tests, mirror the nearest existing package's Vitest setup before inventing a new structure.
