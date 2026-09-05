# Project permission defaults — validation

Implementation is on `codex/project-permission-defaults`, branched from `main`. Validation below records local results before PR CI.

## Behavior

- New workers and orchestrators use Auto unless a project, role, or explicit spawn preference exists.
- The shared chat permission menu offers **Remember for this project**. Selecting a mode alone remains session-only.
- Remember updates only project permissions, removes permission-only role overrides, and retains unrelated configuration.
- Known provider choices carry daemon-owned canonical mappings. Remember stays unavailable for unknown choices and until a provider catalog loads successfully.
- Codex Full access is remembered as portable bypass-permissions, preserving access when a future session uses another harness.
- Persisted launch permissions and legacy-session pinning prevent remembered defaults from changing restore behavior. Existing durable chat choices retain precedence.

## Passed

- Node 24.20.0 TypeScript check: `tsc --project frontend/tsconfig.json --noEmit`.
- 213 frontend tests in eight complete files: TurnSettingsBar, ChatWorkspaceProviderState, SessionChatSurface, useRememberProjectPermissions, useConversationSettings, ProjectSettingsForm, ChatWorkspace, and useConversation.
- Production renderer build using Vite's renderer config. Existing large-chunk warnings remain.
- Complete affected Go suites: domain, SQLite (including store and sqlitetest), session_manager, project/chat services, and HTTP packages. The migration ledger omission found during validation was fixed; the complete SQLite package rerun passed.
- `go build -p 2 ./...` and `go vet -p 2 ./...`.
- Focused storage/project permissions tests with `-race`.
- sqlc regeneration parity and API specification drift tests; OpenAPI and frontend types regenerated using openapi-typescript 7.4.4.
- Independent specification and code-quality reviews; identified races and restore gaps were fixed and reviewed again.
- `git diff --check`.

The browser fixture rendered the actual shared composer with an empty orchestrator, displayed the permission menu and Remember action, and showed the saved-state message. Fixture persistence was simulated; daemon persistence is covered by the storage/service/controller tests. Temporary fixture files, server, browser tab, and borrowed dependency symlinks were removed after verification.

## Broader validation gaps

The full frontend suite was attempted under Node 24 with two workers, then stopped after long timeouts in untouched SessionsBoard, GlobalSettingsForm, SessionView, and browser-history-store tests. Landing tests initially lacked their dependencies. Earlier timing failures in ProjectSettingsForm passed on the complete-file rerun. No full-frontend-suite pass is claimed.

The earlier whole-repository Go run had timing failures in untouched fake/Pi/CLI tests. No whole-repository Go pass is claimed. The affected suites, build, vet, and focused race checks passed on the final code.

`ao preview` could not attach because this Codex task has no `AO_SESSION_ID`. Native packaged desktop end-to-end tests, remote CI, and publishing were not performed.

## Necessary generator repair

Regenerating sqlc required repairing existing tab indentation and a missing boolean override in `backend/sqlc.yaml`, plus aligning agent-switch SELECT/INSERT column order with the migration schema. Generated named-field bindings preserve behavior. No merged migration was edited; permission storage is a new migration, 0127.
