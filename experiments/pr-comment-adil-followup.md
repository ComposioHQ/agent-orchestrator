## Adil — refining the ask (D3 + ownership of next steps)

Two clarifications on top of the reproduction comment above.

### 1. Run at **both** 5 and 20 agents, not just 5

Our real-agent data point is a single 5-agent run (4944 GraphQL pts in 31 min ≈ 9572 pts/hr, 191% of budget). That's enough to know we have a problem, but it doesn't tell us how the cost scales. Two specific questions we can only answer with a second scale point:

- **Is per-agent gh consumption flat, sub-linear, or super-linear?** If 20 agents consume ~4× the 5-agent rate, the bottleneck is per-agent independent calls. If it's much higher (super-linear), there's some shared retry/contention pattern we're missing. If it's lower (sub-linear), agents are spending more time idle/blocked at higher concurrency.
- **At what agent count does the bucket actually exhaust?** We hit 0 at 5 agents in 31 min. At 20 agents it'll exhaust much faster — knowing how fast tells us whether throttling shows up as 429s mid-session or only between waves.

So please do **two runs**, same setup, same trace files (different `${TS}`):

```bash
# Run 1: 5 agents, 30 min  (matches my run for direct comparison)
# Run 2: 20 agents, 20 min  (shorter — the bucket will drain fast; capture the curve before 429s)
```

Use the same procedure from the comment above for both. For Run 2, swap `per_page=5` → `per_page=20` in the issue-fetch line, and reduce the `sleep 1800` to `sleep 1200`.

If 20 real agents is impractical on your test repo (CI queue, fork limits, whatever), do 10 instead and note it — any second scale point is more useful than none.

### 2. After the runs, please own the next steps

Once your trace data is in, please pick up the rest of Track D rather than handing back to me:

- **D4 (categorize + decide reduction strategy):** With both your trace and mine in hand, group calls by subcommand, identify duplicates, identify phase concentration (which lifecycle states burn the most). Then propose: cache, prompt guidance, App tokens, or MCP migration. Open a follow-up PR or comment with the recommendation.
- **B5 (migrate remaining CLI/web callsites to `execGhObserved`):** Mechanical, parallelizable with D4. Grep for the bare `gh()` helper and bare `gh.api.graphql(` calls in `packages/cli/` and `packages/web/`, route them through `execGhObserved`. This closes the AO-side visibility gap so we never have another "we can't see who called what" moment.

I'll handle D1 (the wrapper patch) so you're not blocked on me for the runs.

### TL;DR

- Two real-agent runs: **5 agents** (reproduce my number) and **20 agents** (scale point)
- Send back the same three artifacts I asked for, for both runs
- Then own D4 (analysis + strategy decision) and B5 (callsite migration)
- I'll land D1 before you start so the traces have data
