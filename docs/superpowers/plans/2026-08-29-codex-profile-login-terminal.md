# Codex Profile Login Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a secure, profile-scoped embedded terminal for all Codex CLI login methods and refresh the profile status after authentication.

**Architecture:** A backend-only trusted terminal API reuses the existing shell-terminal lifecycle without widening its public request. The Codex profile service resolves the selected home and launches a hidden AO login helper that invokes fixed Codex commands with file credential storage. The renderer embeds the returned terminal in the profile card and performs one forced authentication check after the terminal ends.

**Tech Stack:** Go, Cobra, SQLite-backed shell terminals, terminal mux, OpenAPI generation, React, TanStack Query, TanStack Router, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-codex-profile-login-terminal-design.md`

## Global Constraints

- Never accept executable, argv, environment, credentials, or redirect URLs from the renderer.
- Keep `POST /api/v1/shell-terminals` unchanged.
- Invoke Codex with `-c cli_auth_credentials_store="file"` for every method.
- Never place API keys or access tokens in argv, HTTP, logs, terminal echo, or shell history.
- Validate OpenAI API keys with a no-cost authenticated Models API request before passing them to Codex; reject and do not save invalid or unverifiable keys.
- Preserve existing browser-login routes for compatibility.
- Keep all profile state under the selected `CODEX_HOME`.

---

### Task 1: Add a backend-only trusted terminal entry point

**Files:**
- Modify: `backend/internal/service/shellterm/types.go`
- Modify: `backend/internal/service/shellterm/service.go`
- Modify: `backend/internal/service/shellterm/service_test.go`

**Interfaces:**
- Produces: `OpenCommandTerminalInput` and `(*Service).OpenCommandTerminal(context.Context, OpenCommandTerminalInput) (ShellTerminal, error)`.

- [ ] Write failing tests proving trusted argv/env/title/working directory reach the runtime and persistence failure destroys the runtime.
- [ ] Run `cd backend && go test ./internal/service/shellterm -run TestOpenCommandTerminal` and confirm the missing method is the failure.
- [ ] Extract the existing runtime-create/persist/rollback logic and implement `OpenCommandTerminal` without changing `OpenShellTerminalInput`.
- [ ] Run `cd backend && go test ./internal/service/shellterm` and confirm it passes.

### Task 2: Add the fixed interactive Codex login helper

**Files:**
- Create: `backend/internal/cli/codex_login.go`
- Create: `backend/internal/cli/codex_login_test.go`
- Modify: `backend/internal/cli/root.go`

**Interfaces:**
- Produces: hidden `ao codex-login`, with fixed Codex argv for browser, device, API-key, and access-token modes.

- [ ] Write failing command tests for the four literal argv sets, invalid selection, missing Codex, and secret input not appearing in output or argv.
- [ ] Run `cd backend && go test ./internal/cli -run CodexLogin` and confirm the command is missing.
- [ ] Implement the hidden menu, no-echo secret reader, and child process execution with inherited PTY streams.
- [ ] Run `cd backend && go test ./internal/cli -run CodexLogin` and confirm it passes.

### Task 3: Resolve a profile and open its login terminal

**Files:**
- Modify: `backend/internal/service/agent/codex_profiles.go`
- Modify: `backend/internal/service/agent/codex_profiles_test.go`
- Modify: `backend/internal/service/agent/service.go`
- Modify: `backend/internal/daemon/daemon.go`

**Interfaces:**
- Consumes: `shellterm.OpenCommandTerminalInput`.
- Produces: `CodexProfileLoginTerminalStart`, `SetCodexProfileLoginTerminalOpener`, and `OpenCodexProfileLoginTerminal`.

- [ ] Write failing tests proving unknown/broken profiles are rejected and valid profiles launch only the current AO executable plus `codex-login`, with the exact private `CODEX_HOME`.
- [ ] Run `cd backend && go test ./internal/service/agent -run LoginTerminal` and confirm the API is missing.
- [ ] Implement late-bound terminal opening and wire it after `shellterm.Service` construction.
- [ ] Run `cd backend && go test ./internal/service/agent -run LoginTerminal` and confirm it passes.

### Task 4: Expose the narrow profile login-terminal route

**Files:**
- Modify: `backend/internal/httpd/controllers/codex_profiles.go`
- Modify: `backend/internal/httpd/controllers/codex_profiles_test.go`
- Modify: `backend/internal/httpd/controllers/dto.go`
- Modify: `backend/internal/httpd/apispec/specgen/build.go`
- Regenerate: `backend/internal/httpd/apispec/openapi.yaml`
- Regenerate: `frontend/src/api/schema.ts`

**Interfaces:**
- Produces: `POST /api/v1/agents/codex/profiles/{profileId}/login-terminal` with no body and a display-safe terminal response.

- [ ] Write a failing controller test for the successful response, unknown-profile error envelope, nil service 501, and rejection of a request body.
- [ ] Run `cd backend && go test ./internal/httpd/controllers -run CodexProfileLoginTerminal` and confirm the route is missing.
- [ ] Register the controller method and generated API operation/schema.
- [ ] Run `npm run api`.
- [ ] Run `cd backend && go test ./internal/httpd/...` and confirm route/spec parity passes.

### Task 5: Run and verify the terminal inline in the renderer

**Files:**
- Modify: `frontend/src/renderer/hooks/useCodexProfilesQuery.ts`
- Modify: `frontend/src/renderer/hooks/useCodexProfilesQuery.test.tsx`
- Modify: `frontend/src/renderer/components/settings/CodexProfilesSection.tsx`
- Modify: `frontend/src/renderer/components/settings/CodexProfilesSection.test.tsx`
- Modify: `frontend/src/renderer/stores/ui-store.ts`
- Modify: `frontend/src/renderer/routes/_shell.tsx`
- Modify: `frontend/src/renderer/i18n/*.json`

**Interfaces:**
- Consumes: the generated login-terminal response and existing `ensureCodexProfiles` endpoint.
- Produces: a single inline terminal workflow with event-driven authentication verification and confirmed PTY cleanup.

- [ ] Write failing component tests proving Sign in calls the new route, keeps Settings open on Agents, expands only the selected card, and never calls `openExternal`.
- [ ] Write failing terminal-state tests proving exit/error causes exactly one forced authentication ensure with no interval.
- [ ] Run the focused Vitest files and confirm the expected failures.
- [ ] Implement the mutation, inline workflow state, terminal-state callback, safe close/retry/timeout behavior, and updated copy.
- [ ] Run the focused Vitest files and frontend typecheck.

### Task 6: Verify the complete change

**Files:** All files above.

- [ ] Run `gofmt` on changed Go files.
- [ ] Run `npm run api` and verify no generated drift remains.
- [ ] Run `cd backend && go test ./internal/service/shellterm ./internal/service/agent ./internal/cli ./internal/httpd/...`.
- [ ] Run `npm run frontend:typecheck` and the focused frontend tests.
- [ ] Run `cd backend && go build ./...` and `cd frontend && npm run build`.
- [ ] Run `git diff --check` and review `git diff --stat` plus every changed file for credential leakage or public argv/env exposure.
