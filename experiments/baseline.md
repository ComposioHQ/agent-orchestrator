# Baseline Measurements

**Branch:** `feat/gh-rate-limiting`
**Purpose:** Scenario × scale × topology matrix of GH API consumption under current (unfixed) behavior. Gates Track B fixes.

---

## Completed Cells

### Cell: S2-T1-5 — Quiet Steady State, Single Repo, 5 Sessions

The first real measurement. Two independent runs by different operators on separate machines to verify reproducibility.

#### Run 1 — Adil (@whoisasx), 2026-04-15

| Field | Value |
|-------|-------|
| Operator | @whoisasx |
| Trace file | gh-trace-1776260288.jsonl (gist linked in PR #1238 comment) |
| Repo | illegalcall/todo-app |
| Sessions | 5 |
| Duration | 32 min 41 sec |
| Total calls | 974 |
| Calls/min | 29.8 |

**By operation:**

| Operation | Count | % |
|-----------|------:|--:|
| gh.pr.list | 184 | 18.9% |
| gh.api.graphql | 159 | 16.3% |
| gh.pr.view | 139 | 14.3% |
| gh.api.--method | 128 | 13.1% |
| gh.api.graphql-batch | 106 | 10.9% |
| gh.api.guard-pr-list | 106 | 10.9% |
| gh.pr.checks | 99 | 10.2% |
| gh.issue.view | 53 | 5.4% |

**HTTP status (of rows that have it):**

| Status | Count | Notes |
|--------|------:|-------|
| none | 868 | CLI subcommands — no HTTP visibility (Gap 1) |
| 304 | 91 | ETag guard hit but treated as error (Bug #1) |
| 200 | 15 | Fresh fetches |

**Rate-limit burn (from headers):**

| Resource | Window | Remaining start→end | Delta | Elapsed | Burn rate |
|----------|--------|---------------------|------:|--------:|----------:|
| (naive) | mixed | 4995 → 4981 | 14 | 32.7 min | 25.7/hr |

> **Note:** Adil's run had `gh.api.--method` as an operation name (128 calls, 13.1%). This is the unbounded-cardinality bug in `extractOperation()` — fixed in blocker #2 (first path segment extraction). The 128 calls are `gh api --method GET repos/.../pulls/:n/comments` — REST per-PR comment fetches.

> **Note:** The naive burn rate of 25.7/hr is misleadingly low. Only 106/974 rows (10.9%) had rate-limit headers. The 304s (91 calls) don't decrement the bucket but aren't visible per-call either. True burn is underreported because CLI subcommands (868 rows) don't expose headers.

---

#### Run 2 — Dhruv (@illegalcall), 2026-04-16

| Field | Value |
|-------|-------|
| Operator | @illegalcall |
| Trace file | gh-trace-verify-1776345900.jsonl |
| Repo | illegalcall/todo-app |
| Sessions | 6 (5 issues + 1 project) |
| Duration | 22 min 21 sec |
| Total calls | 234 |
| Calls/min | 10.5 |
| Success rate | 81.6% (191 ok, 43 failed) |

**By operation:**

| Operation | Count | % |
|-----------|------:|--:|
| gh.api.graphql | 46 | 19.7% |
| gh.api.repos | 46 | 19.7% |
| gh.api.guard-pr-list | 35 | 15.0% |
| gh.api.graphql-batch | 35 | 15.0% |
| gh.pr.view | 25 | 10.7% |
| gh.issue.view | 16 | 6.8% |
| gh.pr.list | 16 | 6.8% |
| gh.pr.checks | 15 | 6.4% |

**HTTP status (of rows that have it):**

| Status | Count | Notes |
|--------|------:|-------|
| none | 164 | CLI subcommands — no HTTP visibility |
| 200 | 43 | Fresh fetches |
| 304 | 27 | ETag guard hits (treated as failures — Bug #1) |

**Failure breakdown:**

| Exit code | Operation | Count | Cause |
|-----------|-----------|------:|-------|
| 1 | gh.api.guard-pr-list | 27 | 304 treated as error (Bug #1) |
| 1 | gh.pr.checks | 15 | No PR exists yet for new sessions |
| 1 | gh.issue.view | 1 | Unknown |

**Rate-limit burn (per reset window):**

| Resource | Reset window | Remaining start→end | Delta | Elapsed | Burn rate |
|----------|-------------|---------------------|------:|--------:|----------:|
| graphql | 13:41:05Z | 4714 → 4537 | 177 | 7.5 min | 1,416/hr |
| core | 13:49:03Z | 4994 → 4987 | 7 | 15.0 min | 28/hr |
| graphql | 14:41:10Z | 4995 → 4872 | 123 | 9.0 min | 820/hr |

**Rate-limit before/after snapshots:**

| Bucket | Before | After | Notes |
|--------|--------|-------|-------|
| core | remaining=4997, used=3 | remaining=4940, used=60 | Same reset window → 57 tokens burned |
| graphql | remaining=4909, used=91 | remaining=4875, used=125 | **Different reset windows** — crossed boundary |

---

### Cross-Run Comparison

| Metric | Run 1 (Adil, 33min) | Run 2 (Dhruv, 22min) | Notes |
|--------|---------------------|----------------------|-------|
| Calls/min | 29.8 | 10.5 | Run 1 was longer, more PRs existed → more per-PR calls |
| GraphQL burn/hr | ~25.7 (naive, unreliable) | 820–1,416/hr (per-window) | Per-window is the reliable number |
| Core burn/hr | (not split) | 28/hr | Negligible |
| 304 rate | 91/974 (9.3%) | 27/234 (11.5%) | Consistent — ~10% of calls hit the dead ETag guard |
| Header coverage | 106/974 (10.9%) | 70/234 (29.9%) | Run 2 has better coverage due to blocker #1 fix (`-i` flag) |
| graphql-batch calls | 106 | 35 | ~3/min in both runs |
| guard-pr-list calls | 106 | 35 | 1:1 with graphql-batch (expected — guard runs before batch) |

**Key finding:** `graphql-batch` is the dominant measured budget consumer. Per-window burn of 820–1,416 tokens/hr at 5–6 sessions. REST core at 28/hr is negligible by comparison.

**Bug #1 observation:** 304-as-error causes most guard-pr-list calls to be treated as changes, which drives unnecessary `graphql-batch` calls. Bug #1 is the first high-confidence cause to remove.

---

## Extrapolation Table (Linear, Unfixed Behavior)

| Sessions | GraphQL burn/hr (low est) | GraphQL burn/hr (high est) | Budget (5,000/hr) | Headroom |
|---------:|--------------------------:|---------------------------:|-------------------:|:---------|
| 5 | 820 | 1,416 | 5,000 | ~3.5–6x safe |
| 10 | 1,640 | 2,832 | 5,000 | ~1.8–3x safe |
| 25 | 4,100 | 7,080 | 5,000 | OVER at high end |
| 50 | 8,200 | 14,160 | 5,000 | 1.6–2.8x OVER |

> Linear extrapolation is a floor estimate. Real scaling may be superlinear due to batch query complexity growing with session count.

---

## Pending Cells

The full A2 matrix (6 scenarios × 2 topologies × 5 scales) is defined in `a2-baseline-runbook.md`. Priority cells:

| Cell | Scenario | Topology | Scale | Status |
|------|----------|----------|------:|--------|
| S2-T1-5 | Quiet steady | Single repo | 5 | **Done** (above) |
| S1-T1-5 | Cold start | Single repo | 5 | Pending |
| S3-T1-5 | Spawn storm | Single repo | 5 | Pending |
| S2-T1-10 | Quiet steady | Single repo | 10 | Pending |
| S2-T1-25 | Quiet steady | Single repo | 25 | Pending |
| S4-T1-5 | Review backlog | Single repo | 5 | Pending |
| S2-T2-5 | Quiet steady | Multi repo | 5 | Pending |

These cells are blocked on blocker #5 (sessionId/projectId threading) for per-session attribution, per the runbook prereqs.
