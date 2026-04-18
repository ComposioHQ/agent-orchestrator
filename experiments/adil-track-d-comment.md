@whoisasx

We have one important new finding from the 5-real-agent benchmark: the token burned through GraphQL budget in ~31 min, but the AO trace file was empty, so we still do **not** have per-call attribution. The current conclusion is only: end-to-end real-agent work can exhaust the shared bucket quickly. We still need to prove what the hot commands are.

Next step I want on your machine is Track D:

1. Patch `~/.ao/bin/gh` to append one JSONL row per invocation with:
   - `timestamp`
   - `cwd`
   - `args`
   - `exitCode`
   - `durationMs`
   - `sessionId` if derivable
2. Re-run the same real-agent benchmark:
   - `5` sessions
   - `30m` timeout
   - bracket with `/rate_limit` before/after
   - AO started with `AO_GH_TRACE_FILE=...`
3. Paste back:
   - `/rate_limit` before/after
   - AO trace row count
   - agent-wrapper trace row count
   - top 10 `gh` commands by count
   - top 10 `gh` commands by total wall-clock time
   - counts for:
     - `gh api graphql`
     - `gh pr view`
     - `gh pr checks`
     - `gh issue view`

What I’m trying to answer with this rerun:
- how much of the burn is AO vs agents
- which exact agent commands dominate
- whether the hot path is duplicated/cacheable or fundamentally irreducible

Until we have that trace, any reduction strategy is still guesswork.
