# A2 Baseline Runbook

**Purpose:** Practical execution plan for the Phase A2 scenario x scale x topology matrix.
**Prereq:** A1b blockers 1-4 closed, clean rerun validates tracer visibility.
**Output:** `experiments/baseline.md` — the single artifact that gates Track B.

---

## Setup

### Environment

```bash
# Required: trace file path (enables JSONL recording)
export AO_GH_TRACE_FILE="$PWD/experiments/out/gh-trace-a2-$(date +%s).jsonl"

# Required: ensure we're on the instrumented branch
git checkout feat/gh-rate-limiting
pnpm build
```

### Rate-limit hygiene

Every A2 run must stay inside a single rate-limit reset window (~60 min, resets at top of hour UTC). Practical max per run: ~45 min (start >=5 min after reset, finish >=5 min before next).

Before and after each run, capture a `/rate_limit` snapshot to bracket the coarse subcommand burn (Gap 1 — CLI subcommands are opaque to the tracer):

```bash
# Before run
gh api /rate_limit --jq '.resources.core' > experiments/out/rate-limit-before.json
date -u +%Y-%m-%dT%H:%M:%SZ >> experiments/out/rate-limit-before.json

# After run
gh api /rate_limit --jq '.resources.core' > experiments/out/rate-limit-after.json
date -u +%Y-%m-%dT%H:%M:%SZ >> experiments/out/rate-limit-after.json
```

### Test repos

| Topology | Repos needed | Setup |
|----------|-------------|-------|
| Concentrated | 1 repo with >=50 open issues | Use ComposioHQ/agent-orchestrator or a dedicated test repo |
| Spread | N/5 repos (min 2) | Fork or use 2-10 public repos with open issues |

---

## Matrix definition

### Scenarios (6)

| ID | Scenario | How to trigger | Duration | Key signal |
|----|----------|---------------|----------|------------|
| S1 | Cold start | `ao stop`, clear caches, `ao start` | 5 min after all sessions reach `working` | Burst shape in first 60s, cache-miss count |
| S2 | Quiet steady state | Let sessions idle after reaching `working` | 15-20 min | Polling floor per session (calls/cycle) |
| S3 | Spawn storm | `ao batch-spawn issue1 issue2 ... issueN` | Until all reach `pr_open` | Peak concurrency, burst shape, spawning-phase cost |
| S4 | Review backlog burst | Post 5-10 review comments on M PRs simultaneously | 10 min after comments posted | Reaction-path burst, review-comment API cost |
| S5 | Cache-miss / fallback | Flush in-process ETag cache mid-run (kill+restart `ao start`) | 5 min after restart | Recovery cost, re-fetch storm shape |
| S6 | Dashboard enrichment | Open dashboard, click through sessions | 10 min with dashboard active | Dashboard-attributed calls, separation from lifecycle traffic |

### Topologies (2)

| ID | Topology | Config |
|----|----------|--------|
| T1 | Concentrated | All N sessions on 1 repo |
| T2 | Spread | N sessions across N/5 repos (min 2) |

### Scales (5)

| Sessions | Notes |
|----------|-------|
| 1 | Baseline per-session cost. Concentrated only (can't spread 1 session). |
| 5 | First multi-session. Both topologies. |
| 10 | Moderate load. Both topologies. |
| 25 | Heavy load. Both topologies. |
| 50 | Target capacity. Both topologies. Critical cell. |

### Full matrix (54 cells -> prune to ~20-30)

Pruning rule from PLAN.md: run full matrix once, keep only cells that show meaningfully different numbers from neighbors. "Meaningfully different" = >15% change in any scorecard metric between adjacent scale points.

**Priority cells (run first):**

| Cell | Why |
|------|-----|
| S2-T1-1 | Single-session polling floor. Everything else is measured relative to this. |
| S2-T1-5 | Does cost scale linearly with sessions? |
| S2-T1-50 | Target capacity steady state. THE critical cell. |
| S2-T2-50 | Spread vs concentrated at target. Shows detectPR fan-out impact. |
| S1-T1-50 | Cold start at target. Shows cache-miss storm severity. |
| S3-T1-25 | Spawn storm. Shows burst shape. |
| S4-T1-10 | Review burst. Shows reaction-path cost. |

---

## Per-cell execution procedure

### 1. Prepare

```bash
# Fresh trace file per cell
export AO_GH_TRACE_FILE="$PWD/experiments/out/a2-${SCENARIO}-${TOPO}-${SCALE}-$(date +%s).jsonl"

# Configure agent-orchestrator.yaml with correct repos + session count
# (specific config varies per topology)

# Bracket: capture /rate_limit before
gh api /rate_limit --jq '.resources.core' | tee experiments/out/rl-before-${SCENARIO}-${TOPO}-${SCALE}.json
```

### 2. Run

```bash
# Start lifecycle polling
ao start <projectId>

# Spawn sessions (for spawn-storm scenario, use batch-spawn)
ao batch-spawn issue1 issue2 ... issueN

# Wait for scenario duration (see table above)
# Monitor: tail -f $AO_GH_TRACE_FILE | wc -l

# Stop
ao stop <projectId>
```

### 3. Collect

```bash
# Bracket: capture /rate_limit after
gh api /rate_limit --jq '.resources.core' | tee experiments/out/rl-after-${SCENARIO}-${TOPO}-${SCALE}.json

# Summarize
node experiments/summarize-gh-trace.mjs "$AO_GH_TRACE_FILE"

# Deep analysis
node experiments/analyze-trace.mjs "$AO_GH_TRACE_FILE"
```

### 4. Record

Paste both outputs into `experiments/baseline.md` under the cell's section heading, along with:
- The `/rate_limit` before/after delta (coarse subcommand burn)
- One-line annotation: "what this cell tells us"

---

## Output format for baseline.md

Each cell gets a section:

```markdown
### S2-T1-50: Quiet steady state, concentrated, 50 sessions

**What this cell tells us:** Per-session polling floor at target capacity.
The critical number for the 5000/hr budget.

**Rate-limit bracket:**
- Before: remaining=4823 @ 2026-04-17T14:05:00Z
- After:  remaining=4650 @ 2026-04-17T14:25:00Z
- Coarse delta: 173 tokens over 20 min (includes opaque subcommands)

**summarize-gh-trace.mjs output:**
```
(paste here)
```

**analyze-trace.mjs output:**
```
(paste here)
```

**JSONL:** experiments/out/a2-S2-T1-50-1713362700.jsonl (N rows)
```

---

## Scorecard (from PLAN.md)

Every cell is evaluated against this scorecard. Track B starts when all priority cells are green:

| Metric | Green | How to measure |
|--------|-------|---------------|
| REST core hourly headroom | >=40% at 50 sessions | `rateLimitRemaining` from trace + bracket delta |
| GraphQL hourly headroom | >=40% at 50 sessions | GraphQL `rateLimit` in-body field (if instrumented) |
| Peak observed concurrency | <50 in-flight | Overlapping `[startedAt, endedAt]` intervals |
| Max req/sec (1s window) | <30/sec | Timestamp bucketing |
| Max req/sec (10s window) | <20/sec sustained | Timestamp bucketing |
| Writes/min during review | <200/min | S4 cells only |
| 403/429/Retry-After count | Exactly 0 | Any non-zero = investigation |

---

## Estimated execution time

- 7 priority cells x ~20 min avg = ~2.5 hrs
- Remaining ~15-20 cells x ~15 min avg = ~5 hrs
- Total: ~1-2 days of focused execution
- Can be parallelized across machines if using separate PATs (different rate-limit buckets)

---

## Open questions for A2

1. **Test repo setup:** Do we use ComposioHQ/agent-orchestrator itself, or create a dedicated test repo with synthetic issues? Using the real repo is more realistic but creates noise.
2. **Agent choice:** Should A2 runs use a real agent (claude-code) or a mock agent that just sits idle? Real agent generates real PR activity but costs money and is harder to control. Mock agent isolates the lifecycle/polling cost.
3. **Dashboard load simulation:** S6 requires a browser hitting the dashboard. Manual clicking or scripted? Playwright could automate this.
