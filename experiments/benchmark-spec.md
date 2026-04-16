# Benchmark Harness Design

**Date:** 2026-04-16
**Status:** v1 spec
**Branch:** `feat/gh-rate-limiting`
**Relates to:** `experiments/PLAN.md` Track A, Phase A2

---

## Purpose

A repeatable benchmark harness that measures AO's GitHub API consumption for a standardized scenario and produces a scorecard. The scorecard is the compass for evaluating rate-limiting fixes: run the benchmark before a change, run it after, compare the numbers.

The harness does not discover limits or run multiple scenarios automatically. It runs **one scenario, one time, and prints a number**. Scaling and comparison come from running it repeatedly with different parameters.

---

## CLI Interface

```bash
# One-time: create the scenario (expensive — spawns agents, waits for PRs)
node experiments/benchmark.mjs setup \
  --project todo-app \
  --sessions 20 \
  --issues 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20

# Repeatable: capture a measurement (cheap — just polls, no agent tokens)
node experiments/benchmark.mjs measure \
  --project todo-app \
  --sessions 20 \
  --warmup 2m \
  --duration 15m

# Offline: regenerate scorecard from existing trace
node experiments/benchmark.mjs report \
  --trace experiments/out/gh-trace-bench-1776400000.jsonl
```

Three modes. Each does one thing.

---

## Modes

### `setup`

Creates the scenario state that `measure` will observe. This is the expensive, one-time step.

**Parameters:**

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--project` | yes | — | Project name from `agent-orchestrator.yaml` |
| `--sessions` | yes | — | Number of sessions to spawn |
| `--issues` | yes | — | Comma-separated issue numbers to assign |

**Flow:**

1. Resolve project config from `agent-orchestrator.yaml` (path, repo, defaultBranch)
2. Validate: issue count must equal session count
3. Clean stale worktrees for the project (`git worktree list`, remove any with dead tmux sessions, `git worktree prune`)
4. Start AO: `node packages/cli/dist/index.js start {project} --no-dashboard`
   - Do **not** set `AO_GH_TRACE_FILE` — setup calls should not pollute measurement traces
5. Run `batch-spawn` with the given issue numbers
6. Discover branch and worktree path for each session:
   - Worktree path: read from `git -C {projectPath} worktree list` — match session ID in the path (e.g. `~/.worktrees/todo-app/ta-12`)
   - Branch: read from AO session metadata at `~/.agent-orchestrator/{hash}-{projectId}/sessions/{sessionId}` (the `branch` key), or fallback to `git -C {worktreePath} branch --show-current`
   - Record both `worktreePath` and `branch` in the sessions array immediately (before PR polling)
7. Wait for PR readiness:
   - Poll every 30s: for each session, check if a PR exists on that session's known branch (`gh pr list --head {branch} --repo {repo} --json number,url`)
   - A session is ready when its branch has an open PR. Record `prNumber` and `prUrl` as soon as found.
   - Timeout: 10 minutes. If not all sessions have PRs by then, write a partial setup artifact with `ready: false` and only the sessions that do have PRs
   - These `gh` calls are made outside the trace (no `AO_GH_TRACE_FILE` set), so they don't pollute
8. Kill agent tmux sessions (agents have done their job — created PRs)
9. Stop AO (SIGTERM)
10. Write setup artifact to `experiments/out/setup-{project}-{scenarioId}.json`
11. Print summary

**Cleanup/reuse semantics:**

- If a setup artifact already exists for this scenarioId, setup checks whether the sessions and PRs still exist. If they do, it skips spawning and prints "Setup already exists, reusing." If they're stale (worktrees removed, PRs closed), it removes the old artifact and runs fresh.
- Setup does not close PRs or delete worktrees from previous runs of *different* scenarioIds. That's manual cleanup.
- v1 does not implement a `cleanup` mode. The contract is: setup creates state, the user is responsible for cleaning up when done (close PRs, remove worktrees). A future `cleanup` mode can read the setup artifact and tear down everything it created.

### `measure`

The repeatable compass. Captures one benchmark run against an existing setup.

**Parameters:**

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--project` | yes | — | Project name (used to find setup artifact) |
| `--sessions` | yes | — | Session count (resolves which setup artifact to use: `setup-{project}-quiet-steady.single-repo.{sessions}.json`) |
| `--warmup` | no | `2m` | Warmup period before measurement window starts |
| `--duration` | yes | — | Measurement window length (e.g. `15m`, `10m`) |

**Flow:**

1. Derive scenarioId from flags: `quiet-steady.single-repo.{sessions}` (v1 hardcodes scenario and topology). Find setup artifact at `experiments/out/setup-{project}-{scenarioId}.json`. Refuse if missing.
2. Validate setup — for each session in the artifact:
   - Worktree exists at `session.worktreePath` (recorded by setup)
   - PR is still open (`gh pr view {prNumber} --repo {repo} --json state` — must be `OPEN`)
   - If any session fails validation, print which ones and refuse to run. Do not silently measure a broken setup.
   - These validation calls are counted in `benchmarkControlCalls` (made outside trace).
3. Set `AO_GH_TRACE_FILE` to `experiments/out/gh-trace-bench-{timestamp}.jsonl`
4. Start AO: `node packages/cli/dist/index.js start {project} --no-dashboard`
5. **Warmup phase:** wait for `--warmup` duration (default 2 min). This lets the lifecycle manager stabilize — first-cycle cache misses, initial PR detection, etc. Trace is recording during warmup but the measurement window hasn't started.
6. Record warmup end timestamp
7. **Capture `/rate_limit` before-snapshot** — use `gh api rate_limit` **without** `AO_GH_TRACE_FILE` set for this call (unset temporarily, or shell out without the env var). Tag and exclude from trace. If tagging is simpler: use component `benchmark-control` and exclude in scorecard math.
8. **Measurement window:** wait for `--duration`. Print countdown on stderr every minute.
9. **Capture `/rate_limit` after-snapshot** — same exclusion as before-snapshot
10. Stop AO (SIGTERM, wait for clean exit, timeout 10s then SIGKILL)
11. Compute scorecard directly from trace file + snapshots (see Scorecard section)
12. Optionally run `summarize-gh-trace.mjs` and `analyze-trace.mjs` as supplemental output (saved alongside, not parsed for scorecard)
13. Write scorecard to `experiments/out/scorecard-{scenarioId}-{timestamp}.json`
14. Print scorecard to stdout

**Benchmark-control call exclusion:**

The benchmark itself makes GH API calls (`/rate_limit` snapshots). These must not pollute the measured trace. Strategy:

- For `/rate_limit` calls: shell out to `gh api rate_limit` directly (child_process.execFile) without the `AO_GH_TRACE_FILE` env var. This means `execGhObserved` is not in the call path, so no trace row is written.
- If future benchmark-control calls must go through the traced path: tag them with `component: "benchmark-control"` and exclude rows with that component from all scorecard math.

**Warmup window trace rows:**

Trace rows from the warmup period are **included** in the trace file but **excluded** from scorecard math. The scorecard computes metrics only from rows where `timestamp >= warmupEnd && timestamp <= measureEnd`. The trace file contains everything for auditability.

### `report`

Regenerates a scorecard from an existing trace file. Useful for re-analysis after changing scorecard computation, or for comparing old traces.

**Parameters:**

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--trace` | yes | — | Path to trace JSONL file |
| `--warmup-end` | no | — | ISO timestamp to use as warmup end. Rows before this timestamp are excluded from scorecard math. If omitted, all rows are included (no warmup exclusion). |

**Flow:**

1. Read trace file
2. Compute scorecard from trace rows (filtered by warmup-end if provided)
3. Fields unavailable in report mode are set to `null`:
   - `bracketDelta.core`: `null` (no rate-limit snapshots)
   - `bracketDelta.graphql`: `null`
   - `benchmarkControlCalls`: `null` (log-derived, not in the trace)
   - `rateLimitSnapshots`: `null`
4. Write scorecard JSON
5. Print scorecard to stdout

---

## Artifacts

### Setup Artifact

**Path:** `experiments/out/setup-{project}-{scenarioId}.json`

**scenarioId format:** `{scenario}.{topology}.{sessionCount}`
Example: `quiet-steady.single-repo.20`
Full path example: `experiments/out/setup-todo-app-quiet-steady.single-repo.20.json`

**Reuse rule:** `measure` validates the setup artifact before using it. It checks that every session in the artifact still has a matching worktree and an open PR. If any session is stale (worktree missing, PR closed), measure refuses to run and tells you to re-run setup. The scenarioId alone is not sufficient — the artifact body is the contract.

```json
{
  "schemaVersion": 1,
  "benchmarkVersion": "0.1.0",
  "scenarioId": "quiet-steady.single-repo.20",
  "createdAt": "2026-04-16T14:00:00Z",
  "gitSha": "ad10dbf7...",
  "branch": "feat/gh-rate-limiting",
  "project": "todo-app",
  "repo": "illegalcall/todo-app",
  "scenario": "quiet-steady",
  "topology": "single-repo",
  "sessionCount": 20,
  "ready": true,
  "sessions": [
    {
      "sessionId": "ta-12",
      "issue": 1,
      "branch": "feat/issue-1",
      "worktreePath": "/Users/dhruvsharma/.worktrees/todo-app/ta-12",
      "prNumber": 42,
      "prUrl": "https://github.com/illegalcall/todo-app/pull/42"
    }
  ]
}
```

The `sessions` array is the exact mapping. `measure` knows precisely which PRs belong to the benchmark.

### Scorecard Artifact

**Path:** `experiments/out/scorecard-{scenarioId}-{timestamp}.json`

```json
{
  "schemaVersion": 1,
  "benchmarkVersion": "0.1.0",
  "scenarioId": "quiet-steady.single-repo.20",
  "gitSha": "ad10dbf7...",
  "branch": "feat/gh-rate-limiting",
  "measuredAt": "2026-04-16T14:30:00Z",
  "sessionCount": 20,
  "warmup": { "requested": "2m", "actualEnd": "2026-04-16T14:17:02Z" },
  "window": {
    "start": "2026-04-16T14:17:02Z",
    "end": "2026-04-16T14:32:02Z",
    "durationRequested": "15m",
    "durationActual": "15m 0s"
  },
  "resourceWindows": {
    "graphql": { "resetAt": "2026-04-16T15:17:00Z", "straddled": false },
    "core": { "resetAt": "2026-04-16T14:49:03Z", "straddled": true }
  },
  "rateLimitSnapshots": {
    "before": {
      "capturedAt": "...",
      "core": { "limit": 5000, "remaining": 4997, "used": 3 },
      "graphql": { "limit": 5000, "remaining": 4950, "used": 50 }
    },
    "after": {
      "capturedAt": "...",
      "core": { "limit": 5000, "remaining": 4880, "used": 120 },
      "graphql": { "limit": 5000, "remaining": 4200, "used": 800 }
    }
  },
  "scorecard": {
    "totalCalls": 1200,
    "callsPerMin": 80.0,
    "graphqlPointsPerHr": 3000,
    "graphqlPointsPerHrEstimated": false,
    "restCoreRequestsPerHr": 120,
    "restCoreRequestsPerHrEstimated": false,
    "graphqlBatchCount": 180,
    "guardPrList304Count": 170,
    "guardPrListErrorCount": 10,
    "guardPrList304Rate": 0.944,
    "opaqueCallCount": 840,
    "opaqueCallPct": 0.70,
    "bracketDelta": { "core": 117, "graphql": 750 },
    "p50DurationMs": 1014,
    "p95DurationMs": 1400,
    "p99DurationMs": 1800,
    "benchmarkControlCalls": 2
  },
  "trace": "experiments/out/gh-trace-bench-1776400000.jsonl",
  "supplemental": {
    "summarizerOutput": "experiments/out/summary-bench-1776400000.txt",
    "analyzerOutput": "experiments/out/analysis-bench-1776400000.txt"
  }
}
```

**Metric definitions:**

| Metric | Unit | Source | Definition |
|--------|------|--------|------------|
| `totalCalls` | count | trace | All non-benchmark-control rows in measurement window |
| `callsPerMin` | rate | trace | totalCalls / windowDurationMinutes |
| `graphqlPointsPerHr` | points/hr | trace | Group rows by `rateLimitReset` value for graphql resource. Within each window: delta = first remaining - last remaining. Sum deltas across windows, divide by measurement duration in hours. If zero rows have graphql rate-limit headers, fall back to `bracketDelta.graphql` normalized to 1hr and mark `graphqlPointsPerHrEstimated: true`. Never mix per-row and bracket sources for the same resource. |
| `graphqlPointsPerHrEstimated` | boolean | — | `true` when `graphqlPointsPerHr` was computed from bracket delta instead of per-row headers. Absent or `false` when per-row data was used. |
| `restCoreRequestsPerHr` | requests/hr | trace | Same window-grouping method as graphql but for core resource. Same fallback rule: bracket delta with `restCoreRequestsPerHrEstimated: true` when zero per-row headers exist. |
| `restCoreRequestsPerHrEstimated` | boolean | — | Same as graphql estimated flag, for core resource. |
| `graphqlBatchCount` | count | trace | Rows where `operation === "gh.api.graphql-batch"` |
| `guardPrList304Count` | count | trace | Rows where `operation === "gh.api.guard-pr-list"` AND `httpStatus === 304` |
| `guardPrListErrorCount` | count | trace | Rows where `operation === "gh.api.guard-pr-list"` AND `ok === false` AND `httpStatus !== 304` |
| `guardPrList304Rate` | ratio | trace | 304Count / (304Count + successCount + errorCount) for guard-pr-list |
| `opaqueCallCount` | count | trace | Rows where `httpStatus` is null/missing |
| `opaqueCallPct` | ratio | trace | opaqueCallCount / totalCalls |
| `bracketDelta.core` | tokens | snapshots | before.core.remaining - after.core.remaining |
| `bracketDelta.graphql` | tokens | snapshots | before.graphql.remaining - after.graphql.remaining |
| `p50/p95/p99DurationMs` | ms | trace | Percentiles of `durationMs` across all rows |
| `benchmarkControlCalls` | count | log | Number of GH API calls made by the harness itself outside the trace (rate-limit snapshots, PR readiness checks, any future control calls). The harness increments a counter each time it shells out to `gh` for its own purposes. Informational — confirms these calls didn't pollute the trace. |

**`guardPrList304Rate` rationale:** Before B1 fix, 304s show up as failures (exit code 1). After B1, they show up as successes (return false). The metric counts 304 HTTP status regardless of how the caller treated it — so it remains meaningful across the fix boundary. `guardPrListErrorCount` captures genuine errors (network failures, auth issues) separately.

**`resourceWindows`:** Records whether the measurement window straddled a rate-limit reset boundary for each resource. If `straddled: true`, the per-row burn rate is authoritative; the bracket delta underreports because the bucket refilled mid-run.

---

## Console Output

```
═══════════════════════════════════════════════════════════
  GH Rate-Limit Benchmark
  quiet-steady.single-repo.20 | ad10dbf7 | feat/gh-rate-limiting
  2026-04-16T14:32:02Z | warmup 2m | measured 15m | 20 sessions
═══════════════════════════════════════════════════════════

  Total GH calls:          1,200
  Calls/min:                80.0

  GraphQL points/hr:       3,000  / 5,000  ████████████░░░░░░░░  60%
  REST core requests/hr:     120  / 5,000  █░░░░░░░░░░░░░░░░░░   2%

  graphql-batch count:       180
  guard-pr-list 304s:        170  (94.4%)
  guard-pr-list errors:       10

  Opaque calls:              840  (70.0%)
  Bracket delta (core):      117
  Bracket delta (graphql):   750

  p50 / p95 / p99:     1,014 / 1,400 / 1,800 ms

  Trace:     experiments/out/gh-trace-bench-1776400000.jsonl
  Scorecard: experiments/out/scorecard-quiet-steady.single-repo.20-1776400000.json
═══════════════════════════════════════════════════════════
```

Budget bars: green (<50%), yellow (50-80%), red (>80%). ANSI colors in terminal, plain in non-TTY.

---

## Measured Scenario Definition

### quiet-steady (v1 — the only scenario)

The benchmark measures the cost of AO's lifecycle polling against sessions that are in a stable state. This isolates the polling overhead from agent activity.

**Preconditions:**
- N sessions exist, each with an open PR on the target repo
- No agents are actively running (tmux sessions killed after setup)
- No dashboard is connected (--no-dashboard)
- No manual user activity against the repo during measurement
- All sessions are in stable lifecycle states (pr_open, working, or similar)

**What is measured:**
- Lifecycle manager polling cost: PR state checks, CI checks, review checks
- ETag guard behavior: how often guards fire, how often they trigger full batch refreshes
- GraphQL batch enrichment cost per poll cycle
- REST per-session call cost

**What is not measured:**
- Agent activity (agents are dead)
- Dashboard SSE/WebSocket cost
- Spawn-time cost
- Cold-start cost

---

## Canonical First Benchmark

```bash
node experiments/benchmark.mjs setup --project todo-app --sessions 20 \
  --issues 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20

node experiments/benchmark.mjs measure --project todo-app --sessions 20 --warmup 2m --duration 15m
```

Run this at `--sessions 5`, `--sessions 10`, and `--sessions 20` to produce the first real scaling data. Compare scorecards across the three runs.

After B1 fix lands, re-run the same three to measure improvement.

---

## Implementation Scope

**Single file:** `experiments/benchmark.mjs`

**Dependencies:**
- `packages/core/dist/gh-trace.js` — not imported. Benchmark doesn't use execGhObserved.
- `packages/cli/dist/index.js` — spawned as child process
- `gh` CLI — for rate-limit snapshots (called directly, not through tracer)
- `node:child_process`, `node:fs`, `node:path`, `node:timers/promises` — stdlib only

**Not in v1:**
- `cleanup` mode (documented contract only, no implementation)
- Multiple scenarios (cold-start, spawn-storm, etc.)
- Multi-repo topology
- Automatic scaling discovery
- Scorecard diff/comparison mode
- CI integration
