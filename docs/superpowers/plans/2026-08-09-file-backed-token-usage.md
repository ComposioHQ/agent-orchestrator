# File-Backed Multi-Agent Token Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable terminal-session token usage collection for GitHub Copilot, Kimi Code, Pi, and Qwen Code through AO's existing append-only usage pipeline.

**Architecture:** Add provider source kinds and a new SQLite compatibility migration, then extend the existing collector with small provider profiles for roots, artifact attribution, and discovery. Provider parsers normalize native JSONL records into the current `ModelUsageEvent` vector; the existing ingestor, durable cursors, idempotency keys, aggregation service, API, and CDC remain authoritative.

**Tech Stack:** Go 1.x, SQLite/goose, sqlc-generated storage, Electron/React/TypeScript, Go table tests and integration tests.

## Global Constraints

- This plan covers file-backed TUI sources only: Copilot, Kimi, Pi, and Qwen.
- Grok OTEL is a separate plan because it introduces a loopback protocol receiver.
- Droid remains unsupported; never ingest `summaryTokens` as model usage.
- Do not add prices, currencies, cost estimates, billing APIs, or credit tracking.
- Do not modify migration `0052_model_usage.sql`; add migration `0084_multi_agent_usage.sql`.
- Preserve the loopback/LAN listener boundary and keep all AO-owned state under `AO_DATA_DIR`.
- Total tokens remain inclusive input plus inclusive output; never add cache or reasoning subsets twice.
- Do not hand-edit generated sqlc code.

---

### Task 1: Expand durable usage source contracts

**Files:**
- Create: `backend/internal/storage/sqlite/migrations/0084_multi_agent_usage.sql`
- Create: `backend/internal/storage/sqlite/migrate_multi_agent_usage_test.go`
- Modify: `backend/internal/domain/usage.go`
- Modify: `backend/internal/service/usage/capabilities.go`
- Test: `backend/internal/service/usage/summary_test.go`

**Interfaces:**
- Produces source constants `UsageSourceCopilotShutdown`, `UsageSourceKimiWire`, `UsageSourcePiSession`, and `UsageSourceQwenMonthly`.
- Produces `MetricCoverage(h domain.AgentHarness) domain.UsageMetricCoverage` and extends `SupportedHarness` only as each complete provider task lands.
- Preserves all existing columns, foreign keys, unique keys, indexes, and CDC triggers.

- [ ] **Step 1: Write a failing migration test**

Create a fresh store, insert one binding/source for each new harness/kind pair,
and assert that unknown harness and source-kind strings fail their respective
CHECK constraints. Provider pairing remains enforced by collector attribution,
because `usage_sources` references its binding and SQLite CHECK constraints
cannot query the parent row. The expected valid pairs are:

```go
tests := []struct {
    harness domain.AgentHarness
    kind    domain.UsageSourceKind
}{
    {domain.HarnessCopilot, domain.UsageSourceCopilotShutdown},
    {domain.HarnessKimi, domain.UsageSourceKimiWire},
    {domain.HarnessPi, domain.UsageSourcePiSession},
    {domain.HarnessQwen, domain.UsageSourceQwenMonthly},
}
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `cd backend && go test ./internal/storage/sqlite -run TestMultiAgentUsageMigration -count=1`

Expected: compilation failure for missing source constants or SQLite CHECK failure for the new harnesses.

- [ ] **Step 3: Add source constants and migration**

Add these exact values:

```go
UsageSourceCopilotShutdown UsageSourceKind = "copilot_shutdown"
UsageSourceKimiWire       UsageSourceKind = "kimi_wire"
UsageSourcePiSession      UsageSourceKind = "pi_session"
UsageSourceQwenMonthly    UsageSourceKind = "qwen_monthly"
```

Migration 0084 must rebuild `usage_bindings`, `usage_sources`, and
`model_usage_events` in one foreign-key-safe transaction, copy existing rows,
restore indexes/triggers, and expand only the harness/source CHECK lists. Use
the table-rebuild shape established in migration 0052.

- [ ] **Step 4: Run storage tests and verify GREEN**

Run: `cd backend && go test ./internal/storage/sqlite -run 'TestMultiAgentUsageMigration|TestMigrations' -count=1`

Expected: PASS.

- [ ] **Step 5: Add failing summary coverage tests**

Assert that Qwen cache write and Claude/Kimi/Pi reasoning are nil while native
zeroes for supported metrics remain pointers to zero. Assert Copilot and Qwen
reasoning remain available.

- [ ] **Step 6: Implement the harness metric capability matrix**

Add a small domain value:

```go
type UsageMetricCoverage struct {
    UncachedInput bool
    CacheRead     bool
    CacheWrite    bool
    Reasoning     bool
}
```

Apply coverage in `summary.go` after aggregation; do not add nullable database
columns. Existing Claude and Codex summary behavior must stay unchanged.

- [ ] **Step 7: Run usage summary tests and commit**

Run: `cd backend && go test ./internal/service/usage ./internal/storage/sqlite -count=1`

Commit: `feat: expand token usage source contracts`

---

### Task 2: Generalize source profiles and hook metadata

**Files:**
- Create: `backend/internal/service/usage/source_profile.go`
- Modify: `backend/internal/service/usage/collector.go`
- Modify: `backend/internal/service/usage/collector_test.go`
- Modify: `backend/internal/cli/hooks.go`
- Modify: `backend/internal/cli/hooks_test.go`
- Modify: `backend/internal/daemon/daemon.go`

**Interfaces:**
- Produces `sourceKindForHarness(domain.AgentHarness) (domain.UsageSourceKind, bool)`.
- Extends `SourceRoots` with `CopilotSessions`, `KimiHome`, `PiSessions`, and `QwenUsage`.
- Keeps Codex-only reconciliation and subagent logic behind explicit harness checks.

- [ ] **Step 1: Write failing profile and root tests**

Assert exact default roots:

```text
~/.copilot/session-state
$AO_DATA_DIR/kimi
$PI_CODING_AGENT_DIR/sessions or ~/.pi/agent/sessions
~/.qwen/usage
```

Assert every source path outside its provider root is rejected.

- [ ] **Step 2: Run collector tests and verify RED**

Run: `cd backend && go test ./internal/service/usage -run 'TestDefaultSourceRoots|TestValidateSourcePath' -count=1`

Expected: missing fields/profile behavior.

- [ ] **Step 3: Implement source profiles**

Move repeated Claude/Codex source-kind selection into
`sourceKindForHarness`. Extend `allowedRoots`, `discoverPath`, hook registration,
backfill, and reconciliation through this helper while preserving the special
Claude subagent and Codex child branches.

- [ ] **Step 4: Add failing hook metadata tests**

For Copilot, Kimi, and Qwen session-start payloads, assert `hookUsageMetadata`
returns bounded harness/native ID/model/path metadata. Pi remains hookless.

- [ ] **Step 5: Generalize hook usage metadata**

Allow certified hook-capable harnesses through `hookUsageMetadata`; reuse
`hookAgentSessionID` rather than adding provider-specific duplicate ID parsing.
Do not forward arbitrary payload content.

- [ ] **Step 6: Wire all file roots into the daemon watcher**

Pass the new roots to `NewPipeline`. Empty/nonexistent roots must remain safe;
the watcher already handles root availability and retries.

- [ ] **Step 7: Run focused tests and commit**

Run: `cd backend && go test ./internal/cli ./internal/service/usage ./internal/observe/usage ./internal/daemon -count=1`

Commit: `refactor: add token usage source profiles`

---

### Task 3: Add GitHub Copilot cumulative usage

**Files:**
- Create: `backend/internal/observe/usage/copilot_parser_test.go`
- Modify: `backend/internal/observe/usage/parser.go`
- Modify: `backend/internal/service/usage/collector_test.go`
- Modify: `backend/internal/service/usage/capabilities.go`

**Interfaces:**
- Parser state: `Copilot *copilotParserStateV1` with `Models map[string]copilotTokenVector`.
- Source artifact: `<CopilotSessions>/<native-id>/events.jsonl`.
- Source event key includes native root ID, model ID, and the cumulative vector.

- [ ] **Step 1: Write failing parser tests**

Use a sanitized shutdown record:

```json
{"type":"session.shutdown","data":{"modelMetrics":{"claude-haiku-4.5":{"usage":{"inputTokens":111529,"outputTokens":901,"cacheReadTokens":86021,"cacheWriteTokens":25483,"reasoningTokens":251}}}}}
```

Assert full first emission, no emission for an identical repeated summary,
positive deltas for a later summary, independent baselines per model, and
baseline reset plus anomaly for a regression.

- [ ] **Step 2: Run the parser test and verify RED**

Run: `cd backend && go test ./internal/observe/usage -run TestParseCopilot -count=1`

Expected: unsupported source format.

- [ ] **Step 3: Implement Copilot state and parser**

Normalize:

```text
input = inputTokens
uncached = inputTokens - cacheReadTokens - cacheWriteTokens
cache_read = cacheReadTokens
cache_write = cacheWriteTokens
output = outputTokens
reasoning = reasoningTokens
```

Reject negative fields and vectors where cache subsets exceed input or
reasoning exceeds output.

- [ ] **Step 4: Add failing Copilot discovery test**

Create `<root>/<uuid>/events.jsonl`, record a Copilot hook containing the UUID,
and assert one `copilot_shutdown` source is registered. Also assert a sibling
UUID cannot be attributed to the binding.

- [ ] **Step 5: Implement discovery/attribution and enable Copilot**

Add the exact path rule and only then include `HarnessCopilot` in
`SupportedHarness`.

- [ ] **Step 6: Run provider and integration tests and commit**

Run: `cd backend && go test ./internal/observe/usage ./internal/service/usage ./internal/storage/sqlite -count=1`

Commit: `feat: collect Copilot token usage`

---

### Task 4: Add Kimi root and subagent usage

**Files:**
- Create: `backend/internal/observe/usage/kimi_parser_test.go`
- Modify: `backend/internal/observe/usage/parser.go`
- Modify: `backend/internal/service/usage/collector.go`
- Modify: `backend/internal/service/usage/collector_test.go`
- Modify: `backend/internal/service/usage/capabilities.go`

**Interfaces:**
- Kimi index: `<KimiHome>/session_index.jsonl` records containing `sessionId`, `sessionDir`, and `workDir`.
- Kimi sources: `<sessionDir>/agents/*/wire.jsonl`.
- Parser state uses the append-only source cursor; no token baseline is required.

- [ ] **Step 1: Write failing Kimi parser tests**

Use this sanitized native record:

```json
{"id":"usage-1","time":"2026-08-09T10:00:00Z","type":"usage.record","model":"kimi-for-coding","usage":{"inputOther":13,"inputCacheRead":21,"inputCacheCreation":8,"output":5},"usageScope":"turn"}
```

Assert inclusive input 42, uncached 13, read 21, write 8, output 5, reasoning
nil, replay-stable event keys, and rejection of negative fields.

- [ ] **Step 2: Run the parser test and verify RED**

Run: `cd backend && go test ./internal/observe/usage -run TestParseKimi -count=1`

Expected: unsupported source format.

- [ ] **Step 3: Implement Kimi parsing**

Add an append-only parser payload to the state envelope and normalize each
`usage.record`. Ignore unrelated wire records.

- [ ] **Step 4: Write failing Kimi discovery tests**

Build a session index with a valid entry under `<KimiHome>/sessions`, create
`agents/main/wire.jsonl` and `agents/agent-1/wire.jsonl`, and assert both become
sources with distinct `SubagentID` values. Assert deleted index entries and
session directories escaping the sessions root are rejected.

- [ ] **Step 5: Implement Kimi index replay and source registration**

Replay the append-only index so the last record for a session wins. Validate
that `sessionDir` is absolute, below `<KimiHome>/sessions`, and has the native
session ID as its basename. Register every regular `agents/*/wire.jsonl` file.

- [ ] **Step 6: Enable Kimi, run tests, and commit**

Run: `cd backend && go test ./internal/observe/usage ./internal/service/usage -count=1`

Commit: `feat: collect Kimi token usage`

---

### Task 5: Add Pi worktree-correlated usage

**Files:**
- Create: `backend/internal/observe/usage/pi_parser_test.go`
- Modify: `backend/internal/observe/usage/parser.go`
- Modify: `backend/internal/service/usage/collector.go`
- Modify: `backend/internal/service/usage/collector_test.go`
- Modify: `backend/internal/service/usage/capabilities.go`

**Interfaces:**
- Pi header shape: `{"type":"session","id":"<uuid>","cwd":"<absolute-worktree>",...}`.
- Pi message shape: `{"type":"message","id":"<id>","message":{"role":"assistant","provider":"...","model":"...","usage":{...}}}`.
- `ReconcilePath` may establish a Pi binding by matching the canonical header cwd to one live AO Pi session workspace.

- [ ] **Step 1: Write failing Pi parser tests**

Use a session header plus assistant record with `input`, `cacheRead`,
`cacheWrite`, `output`, and nested `cost`. Assert cost is ignored and tokens are
normalized as inclusive input `input + cacheRead + cacheWrite`. Ignore user and
tool-result messages.

- [ ] **Step 2: Run the parser test and verify RED**

Run: `cd backend && go test ./internal/observe/usage -run TestParsePi -count=1`

Expected: unsupported source format.

- [ ] **Step 3: Implement Pi parsing**

Use message ID for the stable key, falling back to offset only when absent.
Use `provider/model` only as the exact model ID when the provider prefix is
needed to avoid ambiguity.

- [ ] **Step 4: Write failing Pi attribution tests**

Create two live Pi AO sessions with different worktrees and one Pi artifact.
Assert only the matching canonical cwd receives a binding/source. Assert an
ambiguous duplicate-worktree match and a non-Pi session are ignored.

- [ ] **Step 5: Implement Pi path reconciliation**

Extend `ReconcilePath` to validate Pi files, read only the bounded first JSONL
record, match cwd to a live Pi session, and create/register the native binding.
Do not import terminated historical sessions.

- [ ] **Step 6: Enable Pi, run tests, and commit**

Run: `cd backend && go test ./internal/observe/usage ./internal/service/usage -count=1`

Commit: `feat: collect Pi token usage`

---

### Task 6: Add Qwen shared monthly usage

**Files:**
- Create: `backend/internal/observe/usage/qwen_parser_test.go`
- Modify: `backend/internal/observe/usage/parser.go`
- Modify: `backend/internal/service/usage/collector.go`
- Modify: `backend/internal/service/usage/collector_test.go`
- Modify: `backend/internal/service/usage/capabilities.go`

**Interfaces:**
- Qwen source: `<QwenUsage>/token-usage-YYYY-MM.jsonl`.
- Parser filters every record by `sessionId == source.NativeRootID`.
- Source event key uses the native record `id` and session ID.

- [ ] **Step 1: Write failing Qwen parser tests**

Use records for two session IDs and sources `main` and
`managed-auto-memory-extractor`. Assert only the bound session is counted, all
of its source categories are included, input is inclusive, cached is a subset,
and thoughts is a subset of output.

- [ ] **Step 2: Run the parser test and verify RED**

Run: `cd backend && go test ./internal/observe/usage -run TestParseQwen -count=1`

Expected: unsupported source format.

- [ ] **Step 3: Implement Qwen parsing**

Require `schemaVersion == 1`, a non-empty ID/model/session ID, non-negative
values, `cachedTokens <= inputTokens`, `thoughtsTokens <= outputTokens`, and
`totalTokens == inputTokens + outputTokens` when total is present.

- [ ] **Step 4: Write failing monthly discovery tests**

Create two monthly files and a hook-captured Qwen session ID. Assert the latest
file is registered initially and a later reconciliation registers the next
month without retiring or replaying the prior generation.

- [ ] **Step 5: Implement Qwen discovery and enable Qwen**

Discover bounded `token-usage-*.jsonl` candidates sorted by month/name and
mtime. Shared-log attribution is enforced by the parser rather than filename.

- [ ] **Step 6: Run tests and commit**

Run: `cd backend && go test ./internal/observe/usage ./internal/service/usage -count=1`

Commit: `feat: collect Qwen token usage`

---

### Task 7: Verify API and frontend token presentation

**Files:**
- Modify: `backend/internal/httpd/controllers/usage_test.go` if existing response fixtures require new harness rows
- Modify: `frontend/src/renderer/components/SessionInspector.tsx`
- Modify: `frontend/src/renderer/components/SessionInspector.test.tsx`
- Modify: `frontend/src/renderer/hooks/useSessionUsage.ts` only if the Developer Mode gate lives there

**Interfaces:**
- Existing `GET /api/v1/sessions/{sessionId}/usage` wire shape remains unchanged.
- Detailed metrics use nullable values to render unavailable source metrics as an em dash.
- Droid receives no fabricated event or total.

- [ ] **Step 1: Add failing HTTP/API aggregation tests**

Insert events for each new harness and assert exact harness/model rows and
canonical totals. Assert no schema change is needed.

- [ ] **Step 2: Run controller tests and verify RED**

Run: `cd backend && go test ./internal/httpd/controllers -run Usage -count=1`

- [ ] **Step 3: Make only compatibility fixes required by the tests**

Do not regenerate OpenAPI unless a response DTO actually changes. If it does,
edit the controller source and spec generator, run `npm run api`, and commit
both generated artifacts together.

- [ ] **Step 4: Add failing frontend tests**

Assert new harness labels/models render through the existing usage component,
unavailable cache-write/reasoning metrics render `—`, and the cost placeholder
remains unpopulated. Assert Droid has no fake zero-token row.

- [ ] **Step 5: Expose certified token usage**

Remove the Developer Mode fetch/display gate only if the backend integration
tests for all four providers are green. Keep the existing loading/error and
incomplete-data behavior.

- [ ] **Step 6: Run frontend tests and commit**

Run: `cd frontend && npm test -- SessionInspector.test.tsx`

Run: `cd frontend && npm run typecheck`

Commit: `feat: expose multi-agent token usage`

---

### Task 8: Final integration verification

**Files:**
- Modify: `docs/superpowers/plans/2026-08-09-file-backed-token-usage.md` only to check completed boxes

**Interfaces:**
- Produces a clean, reviewable branch with no generated drift or local artifacts.

- [ ] **Step 1: Run focused backend verification**

Run: `cd backend && go test ./internal/observe/usage ./internal/service/usage ./internal/storage/sqlite ./internal/httpd/controllers -count=1`

- [ ] **Step 2: Run broader backend verification**

Run: `cd backend && go test ./...`

- [ ] **Step 3: Run repository checks**

Run: `npm run frontend:typecheck`

Run: `npm run lint`

- [ ] **Step 4: Check generated and workspace state**

Run: `git diff --check`

Run: `git status --short`

Expected: only intentional tracked changes; no local data, generated drift,
credentials, or build output.

- [ ] **Step 5: Commit final test/doc adjustments**

Commit only if verification required an intentional tracked change:
`test: verify multi-agent token usage`
