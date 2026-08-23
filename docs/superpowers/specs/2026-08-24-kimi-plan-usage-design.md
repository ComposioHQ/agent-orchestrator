# Kimi Plan Usage Design

## Summary

Add Kimi Code subscription quota reporting to the provider-neutral plan-usage system introduced by PR #4218. AO will read Kimi's structured hosted usage endpoint directly, normalize every returned window into the existing quota domain, persist observations through the existing quota service, and render them through the existing generic Plan Usage page.

This change is delivered in a Kimi-only PR based on `FEAT-SUBSCRIPTION-USAGE`. It does not include Cursor support or modify the provider-neutral quota schema.

## Goals

- Show the Kimi Code plan name and every provider-reported usage window, including the commonly reported weekly and five-hour windows.
- Refresh Kimi quota without creating an AO session, worktree, or visible Kimi conversation.
- Reuse PR #4218's refresh coalescing, freshness, history, compaction, alert, API, and frontend behavior.
- Keep credentials transient: never persist or log access tokens, refresh tokens, or API keys.
- Fail safely when Kimi is missing, logged out, configured for a custom provider, or returns an incompatible payload.

## Non-goals

- Do not send the interactive `/usage` command to Kimi or scrape terminal output.
- Do not report per-session context-window usage; that is separate from account plan quota.
- Do not invent quota for BYOK or custom OpenAI-compatible providers.
- Do not implement Kimi billing history, purchases, or extra-usage controls.
- Do not add Kimi-specific branches to the HTTP controller or frontend.

## Provider boundary

The Kimi adapter will expose a daemon-owned `quota.AccountRefresher`. The refresher resolves the installed Kimi binary and the active hosted Kimi Code credential, then performs:

```http
GET https://api.kimi.com/coding/v1/usages
Authorization: Bearer <credential>
Accept: application/json
```

The base URL must identify the hosted Kimi Code service. A config that selects a custom base URL or non-Kimi provider is present as an agent but unsupported as a subscription quota account. AO will not send that provider's credential to `api.kimi.com`.

Credential lookup follows the adapter's existing precedence and supported homes: environment-based Kimi credentials, current `KIMI_SHARE_DIR`, current `KIMI_CODE_HOME`, the normal user Kimi homes, and the AO-managed Kimi home under `AO_DATA_DIR`. The resolver returns an in-memory bearer credential and an auth-mode label. It never returns credentials in errors or logs. OAuth access tokens are used as stored; an HTTP 401 is reported as an authentication refresh error rather than implementing a second OAuth client inside AO.

## Response normalization

The HTTP client decodes a tolerant envelope containing provider metadata plus a `limits` collection. Unknown top-level and limit fields are ignored. Each valid limit becomes one `domain.QuotaLimit`:

- `ID`: the provider's stable identifier when supplied; otherwise a deterministic identifier derived from the duration and time unit.
- `Name`: the provider label when supplied; otherwise a human-readable duration label.
- `Category`: `rate_limit`.
- `Scope`: `account`.
- `UsedPercent`: provider `used / limit * 100`, clamped to the display-safe range only at rendering time; malformed negative values are rejected.
- `RemainingValue`: provider-reported remaining value when present.
- `TotalValue`: provider-reported limit when present.
- `Unit`: the provider unit when present.
- `WindowType`: provider identifier or normalized duration label.
- `WindowDuration`: derived from the duration and time unit when both are valid.
- `ResetsAt`: absolute reset timestamp when supplied, otherwise `ObservedAt + resetIn` when a valid relative duration is supplied.
- `Reached`: provider-reported exhaustion when supplied, otherwise derived only when total and remaining values make exhaustion unambiguous.

The snapshot uses provider `kimi`, account `default`, completeness `complete`, and capabilities `supportsRead` and `supportsHistory`. The plan type and account label are populated only from non-secret provider fields. An empty or wholly invalid `limits` collection is an error, not a successful zero-usage snapshot.

Provider-added windows require no AO release because normalization iterates the collection instead of switching on weekly or five-hour identifiers.

## Daemon integration and refresh lifecycle

Daemon startup obtains the existing Kimi plugin from the agent resolver and registers `kimi/default` with the quota service. `QuotaAccountPresent` returns true only when Kimi is installed and a hosted Kimi Code credential/configuration is discoverable.

Kimi participates in the same lifecycle as Codex and Claude:

- startup refresh when stale;
- Plan Usage page refresh;
- manual account refresh;
- five-minute background refresh;
- idle refresh after a Kimi worker completes a turn.

The quota service's existing singleflight and freshness window remain the only request-coalescing mechanism. The adapter does not add a second cache.

## Errors and retained state

- Missing binary or hosted account: report unsupported during account discovery, so no phantom card is created.
- Missing/expired credential: return a sanitized authentication error.
- Timeout, network error, non-2xx response, malformed JSON, or no valid limits: return a sanitized refresh error.
- Failed refreshes use PR #4218's existing `last_refresh_error` behavior and preserve the last successful snapshot.
- Cancellation and the adapter HTTP timeout must terminate the request promptly.
- Response bodies included in errors are capped and sanitized; authorization headers are never logged.

## Files and responsibilities

- `backend/internal/adapters/agent/kimi/quota.go`: account discovery, credential selection, HTTP read, and quota normalization.
- `backend/internal/adapters/agent/kimi/quota_test.go`: credential precedence, hosted-provider checks, HTTP fixtures, normalization, timeout, and sanitization tests.
- `backend/internal/daemon/daemon.go`: register `kimi/default` and include Kimi in idle-triggered refreshes.
- Relevant daemon wiring tests: prove registration and idle refresh behavior without network calls.
- `frontend/src/renderer/components/usage/PlanUsagePage.test.tsx`: prove an opaque `kimi` provider with dynamic limits renders through the existing generic UI. Production UI code changes are only allowed if this test exposes a provider-neutral defect.

No migration, sqlc regeneration, DTO change, OpenAPI regeneration, or Kimi-specific frontend component is expected.

## Testing

Adapter tests use `httptest.Server` and injected credential/home resolvers. Required cases are:

- weekly and five-hour windows normalize correctly;
- future unknown windows survive normalization;
- absolute and relative reset representations;
- hosted OAuth/API-key account discovery;
- custom/BYOK provider rejection without issuing an HTTP request;
- missing binary and missing credential;
- 401, 429, 5xx, malformed JSON, empty limits, timeout, and cancellation;
- errors and logs do not contain fixture credentials.

Verification runs the narrow adapter and quota tests first, followed by daemon tests, frontend Plan Usage tests, backend tests, frontend typecheck/build, and repository lint.

## Acceptance criteria

- A logged-in hosted Kimi Code installation appears as `kimi/default` on Plan Usage without an active session.
- Every valid provider-reported plan window is displayed with used percentage and reset information when available.
- Refreshing one or many Kimi sessions does not multiply provider requests inside the quota freshness window.
- A refresh failure retains the last good snapshot and surfaces a sanitized error.
- No credential is written to SQLite, API responses, logs, fixtures, or committed files.
- The PR contains no Cursor implementation or provider-neutral schema expansion.
