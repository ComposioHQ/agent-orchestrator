# Kimi Plan Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session-independent Kimi Code subscription quota reads to AO's provider-neutral Plan Usage system.

**Architecture:** A Kimi-owned `QuotaRefresher` resolves only hosted Kimi Code credentials, calls the structured `/usages` endpoint, and returns an existing `domain.QuotaSnapshot`. The daemon registers it as `kimi/default`; quota persistence, refresh coalescing, API, and generic UI remain unchanged.

**Tech Stack:** Go, `net/http`, TOML/JSON credential files, SQLite-backed quota service from PR #4218, React/Vitest for the generic rendering check.

**Spec:** `docs/superpowers/specs/2026-08-24-kimi-plan-usage-design.md`

## Global Constraints

- Call the structured hosted `/coding/v1/usages` endpoint; never run or scrape `/usage`.
- Never send a custom/BYOK credential to `api.kimi.com`.
- Never persist or log an API key, access token, or refresh token.
- Do not add migrations, quota DTO fields, or Kimi-specific frontend branches.
- Tests use `httptest` and injected dependencies; they make no provider network calls.

---

### Task 1: Kimi usage payload normalization

**Files:**
- Create: `backend/internal/adapters/agent/kimi/quota.go`
- Create: `backend/internal/adapters/agent/kimi/quota_test.go`

**Interfaces:**
- Produces: `normalizeUsagePayload(payload kimiUsagePayload, observedAt time.Time) (domain.QuotaSnapshot, error)`

- [ ] **Step 1: Write failing normalization tests**

Cover a weekly summary plus five-hour detail, `remaining`-only input, reset timestamps, relative reset seconds, unknown future windows, and an empty payload. Assert provider `kimi`, account `default`, completeness `complete`, stable IDs, totals, remaining values, percentages, durations, and reset times.

```go
snapshot, err := normalizeUsagePayload(payload, observedAt)
require.NoError(t, err)
require.Equal(t, domain.QuotaProviderID("kimi"), snapshot.Provider)
require.Len(t, snapshot.Limits, 2)
require.InDelta(t, 9, *snapshot.Limits[0].UsedPercent, 0.001)
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `cd backend && go test ./internal/adapters/agent/kimi -run 'TestNormalizeKimiUsage' -count=1`

Expected: FAIL because the normalizer and DTOs do not exist.

- [ ] **Step 3: Implement tolerant provider DTOs and normalization**

Implement internal JSON DTOs matching `usage`, `limits`, nested `detail`, and nested `window`. Accept integer-like JSON numbers, use `used` or derive it from `limit - remaining`, reject negative/invalid totals, parse supported time units, and generate deterministic IDs from normalized labels/durations.

- [ ] **Step 4: Run adapter tests**

Run: `cd backend && go test ./internal/adapters/agent/kimi -count=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/adapters/agent/kimi/quota.go backend/internal/adapters/agent/kimi/quota_test.go
git commit -m "feat: normalize Kimi plan usage"
```

### Task 2: Hosted credential discovery and HTTP refresher

**Files:**
- Modify: `backend/internal/adapters/agent/kimi/quota.go`
- Modify: `backend/internal/adapters/agent/kimi/quota_test.go`
- Modify: `backend/internal/adapters/agent/kimi/auth.go`
- Modify: `backend/internal/adapters/agent/kimi/auth_test.go`

**Interfaces:**
- Produces: `NewQuotaRefresher(plugin kimiPlugin, dataDir string, options ...QuotaOption) *QuotaRefresher`
- Produces: `(*QuotaRefresher).QuotaAccountPresent(context.Context, domain.QuotaProviderID, domain.QuotaAccountID) (bool, error)`
- Produces: `(*QuotaRefresher).RefreshQuota(context.Context, domain.QuotaProviderID, domain.QuotaAccountID) (domain.QuotaSnapshot, error)`

- [ ] **Step 1: Write failing discovery and HTTP tests**

Use temporary Kimi homes and `httptest.Server`. Verify hosted managed config succeeds, AO-managed home is searched, custom provider config is rejected before HTTP, bearer authorization is sent, 401/429/5xx are sanitized, timeout/cancellation work, and fixture secrets never occur in errors.

```go
refresher := NewQuotaRefresher(fakeKimiPlugin{binary: "kimi"}, dataDir, withUsageEndpoint(server.URL))
snapshot, err := refresher.RefreshQuota(ctx, "kimi", "default")
require.NoError(t, err)
require.Equal(t, domain.QuotaComplete, snapshot.Completeness)
```

- [ ] **Step 2: Confirm tests fail**

Run: `cd backend && go test ./internal/adapters/agent/kimi -run 'TestKimiQuota|TestHostedKimiCredential' -count=1`

Expected: FAIL because the refresher is not implemented.

- [ ] **Step 3: Implement secure credential resolution and HTTP read**

Reuse existing config/credential parsing. Add the AO-managed `${dataDir}/kimi` candidate explicitly, require the active managed Kimi Code provider, return only a transient bearer value, use an injected `http.Client`, cap response bodies, apply a 20-second timeout, and map the decoded payload through Task 1's normalizer.

- [ ] **Step 4: Run the full Kimi package tests**

Run: `cd backend && go test ./internal/adapters/agent/kimi -count=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/adapters/agent/kimi
git commit -m "feat: read Kimi subscription quota"
```

### Task 3: Daemon registration and completion refresh

**Files:**
- Modify: `backend/internal/daemon/daemon.go`
- Test: relevant `backend/internal/daemon/*_test.go`

**Interfaces:**
- Consumes: `kimi.NewQuotaRefresher(...)` from Task 2.

- [ ] **Step 1: Add a failing daemon wiring test**

Assert that the Kimi adapter can be selected from the existing resolver and that the idle-refresh harness predicate includes Kimi alongside Codex and Claude.

- [ ] **Step 2: Run the focused daemon test and confirm failure**

Run: `cd backend && go test ./internal/daemon -run 'Test.*Quota.*Kimi' -count=1`

- [ ] **Step 3: Register `kimi/default` and generalize the idle predicate**

Obtain the Kimi plugin from `agents.Agent(domain.HarnessKimi)`, construct the refresher with `cfg.DataDir`, register it, and include Kimi in the existing valid-worker-idle trigger without changing refresh timing.

- [ ] **Step 4: Run daemon and quota tests**

Run: `cd backend && go test ./internal/daemon ./internal/service/quota -count=1`

- [ ] **Step 5: Commit**

```bash
git add backend/internal/daemon
git commit -m "feat: refresh Kimi plan usage"
```

### Task 4: Generic frontend coverage and full verification

**Files:**
- Modify: `frontend/src/renderer/components/usage/PlanUsagePage.test.tsx`
- Modify only if required: `frontend/src/renderer/components/usage/PlanUsagePage.tsx`

**Interfaces:**
- Consumes the existing generated `ProviderQuotaResponse`; no API change.

- [ ] **Step 1: Add a Kimi rendering test**

Provide a `kimi/default` fixture containing weekly, five-hour, and unknown future windows. Assert all provider labels, percentages, and resets render without provider-specific production code.

- [ ] **Step 2: Run the test**

Run: `cd frontend && npm test -- PlanUsagePage.test.tsx`

- [ ] **Step 3: Make only provider-neutral UI fixes exposed by the test**

If the existing humanization/window logic already passes, make no production UI edit.

- [ ] **Step 4: Run final verification**

```bash
cd backend && go test ./internal/adapters/agent/kimi ./internal/service/quota ./internal/daemon ./internal/httpd/controllers
cd frontend && npm test -- PlanUsagePage.test.tsx
npm run frontend:typecheck
npm run lint
git diff --check
```

- [ ] **Step 5: Commit test coverage**

```bash
git add frontend/src/renderer/components/usage/PlanUsagePage.test.tsx frontend/src/renderer/components/usage/PlanUsagePage.tsx
git commit -m "test: cover Kimi plan usage rendering"
```
