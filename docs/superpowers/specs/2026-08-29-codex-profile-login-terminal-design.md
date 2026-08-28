# Codex Profile Login Terminal Design

## Goal

Replace AO's browser-only managed Codex profile sign-in action with a dedicated embedded terminal that supports every login mode exposed by the installed Codex CLI while preserving profile isolation.

## Security boundary

- The renderer selects only a Codex profile id. It never supplies an executable, argv, environment variable, credential, or redirect URL.
- The daemon resolves the profile from its private catalog and rejects unknown or broken profiles before spawning anything.
- The public `POST /api/v1/shell-terminals` request remains limited to project/session context. It does not gain argv or environment fields.
- A backend-only trusted-terminal entry point launches a fixed AO helper with `CODEX_HOME` set to the selected profile home.
- Every Codex login invocation includes `-c cli_auth_credentials_store="file"`, preventing macOS Keychain or another shared credential store from collapsing isolated profiles into one account.
- API keys and access tokens are read from the PTY with echo disabled and are never placed in argv, an AO HTTP body, AO logs, or shell history. Before an OpenAI API key is saved, the helper makes a no-cost authenticated `GET /v1/models` request; a rejected or unverifiable key fails closed and never reaches `codex login`. Validated API keys and access tokens are then piped to Codex stdin.
- Codex continues to own `auth.json` and browser/device authorization. AO does not parse or mutate the credential file.

## User flow

1. The user selects **Sign in** for a valid signed-out Codex profile.
2. The renderer calls `POST /api/v1/agents/codex/profiles/{profileId}/login-terminal` with no body.
3. The daemon opens a standalone terminal titled `Codex login - <profile label>` and returns the normal shell-terminal record.
4. AO closes Settings, selects that terminal, and navigates to `/terminals`.
5. The helper displays four native Codex choices: ChatGPT/browser, device code, API key, and access token. It invokes the installed Codex CLI with the fixed file-store override.
6. While the login terminal is active, the renderer periodically calls the existing profile `ensure` endpoint. The profile cache updates to **Signed in** after Codex reports authorization. The monitor stops when authorization succeeds or the terminal disappears.

## Backend architecture

`shellterm.Service` gains an internal `OpenCommandTerminal` method. Its input contains trusted argv, environment, working directory, and title and is never exposed in the public shell-terminal DTO. The method shares the existing create/persist/rollback path so login terminals keep the same lifecycle and terminal-mux behavior as other standalone terminals.

The agent service receives the terminal opener through late binding after `shellterm.Service` is constructed. `OpenCodexProfileLoginTerminal` refreshes the private profile catalog, validates the profile, resolves the running AO executable, and opens only `ao codex-login` with the selected home in `CODEX_HOME`.

The hidden `ao codex-login` command owns the interactive menu. It discovers `codex`, runs only fixed argument sets, and uses a no-echo password reader for API-key and access-token input.

## API contract

Add:

```text
POST /api/v1/agents/codex/profiles/{profileId}/login-terminal
200 { "profileId": "...", "shellTerminal": { ... } }
```

The route has no request body. Existing browser-login routes remain available for compatibility but the profile settings UI no longer starts them.

## Error handling

- Unknown profile: existing `CODEX_PROFILE_UNKNOWN` envelope.
- Broken profile: `CODEX_PROFILE_INVALID` conflict.
- Missing Codex executable or AO helper startup failure: safe `CODEX_PROFILE_LOGIN_TERMINAL_UNAVAILABLE` response without paths or credentials.
- Terminal persistence failure: destroy the newly created runtime before returning the error.
- Invalid or unverifiable OpenAI API key: explain that the key was not saved and leave the profile unauthorized.
- Login command failure: print Codex's error in the terminal; do not convert it into a daemon credential error.

## Verification

- Go tests cover trusted terminal creation, rollback, server-owned argv/env, profile validation, the route contract, the hidden helper's fixed command mapping and secret handling, and rejection before storage when OpenAI returns 401.
- Frontend tests cover starting the terminal, selecting/navigating to it, and monitoring profile authorization.
- Regenerate OpenAPI and TypeScript types, then run focused backend tests, frontend tests/typecheck, API drift tests, and builds.
