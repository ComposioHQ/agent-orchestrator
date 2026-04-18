# Track D Runbook — Agent-Side `gh` Consumption

**Date:** 2026-04-18  
**Branch:** `feat/gh-rate-limiting`

## Why this exists

Track B proved that **AO-side polling** is comfortably under GitHub budget after the B1 fix. A 5-real-agent run on 2026-04-18 then exhausted the GraphQL bucket in 31 minutes, but the AO trace file was empty, so the run is only valid as a **warning shot**, not a clean attribution benchmark.

What we know:
- `/rate_limit` snapshots prove the token really consumed ~4944 GraphQL points in ~31 min.
- 4 PRs were created by real agents during the run.
- The existing AO tracer (`execGhObserved`) did **not** capture the run.

What we do **not** know yet:
- which `gh` subcommands consumed the budget
- how much came from AO vs agents
- whether the hot calls are duplicated/cacheable or unique/irreducible

Track D closes that gap.

## Current conclusion

The correct interpretation of the first real-agent run is:

- **Valid:** end-to-end real-agent work can burn through the shared GraphQL bucket quickly.
- **Invalid:** the current system's hard real-world ceiling is "~5 agents" or that AO polling itself caused the burn.

So the next work is observability first, optimization second.

## Test sequence

### D1 — Add invocation tracing to `~/.ao/bin/gh`

Goal: capture every agent-side `gh` invocation with zero behavior change.

Minimum row fields:
- `timestamp`
- `cwd`
- `sessionId` if derivable from cwd or env
- `args`
- `exitCode`
- `durationMs`

Nice-to-have:
- `project`
- `repo`
- `isGraphql` / `isApi`
- `stdoutHeaderSample` for `gh api -i` calls only

Acceptance:
- wrapper patch leaves `gh` behavior unchanged
- rows are appended to `~/.ao/traces/agent-gh-YYYY-MM-DD.jsonl`
- a simple smoke test shows normal `gh` commands still work

### D2 — Local rerun on Dhruv's machine

Scenario:
- project: `illegalcall/todo-app`
- `5` real agents
- timeout: `30m`
- bracket with `/rate_limit` before/after
- AO started with `AO_GH_TRACE_FILE=...`
- agent-side wrapper trace enabled at the same time

Collect:
- AO-side trace JSONL
- agent-side wrapper trace JSONL
- `/rate_limit` before/after snapshots
- created PR numbers
- session ids

Questions to answer:
- what fraction of total GraphQL burn is AO vs agent side?
- which agent `gh` subcommands dominate?
- do the hot calls cluster in spawn/PR-creation or continue through steady work?

### D3 — Independent rerun on Adil's machine

Same scenario and same outputs as D2.

Purpose:
- separate local-machine artifacts from generally reproducible behavior
- compare whether the dominant calls are the same
- compare whether burn rate is in the same order of magnitude

### D4 — Categorize and choose reduction path

Decision table:

- If duplicates dominate within a short window:
  - add wrapper-side response cache or short TTL cache
- If one or two `gh` commands dominate:
  - change prompts / workflow to reduce those commands
- If GraphQL queries dominate and are structurally similar:
  - consider GraphQL coalescing or MCP/server-side mediation
- If the demand is mostly irreducible:
  - use separate tokens, GitHub App installation tokens, or move traffic off the shared PAT model

## Outputs required from D2/D3

For every rerun, record:

1. `/rate_limit` delta
2. AO trace row count
3. agent wrapper trace row count
4. top 10 agent `gh` commands by count
5. top 10 agent `gh` commands by total wall-clock time
6. `gh api graphql` count
7. `gh pr view` count
8. `gh pr checks` count
9. `gh issue view` count
10. split between spawn-time first 10 min vs remaining window

## Exit criteria

Track D is ready to move from measurement to optimization when:

- both Dhruv and Adil have one successful rerun with non-empty agent-side traces
- we can name the top cost-driving commands with confidence
- we can classify the hot path as duplicated/cacheable vs unique/irreducible

At that point, D5 can be a targeted reduction plan instead of guesswork.
