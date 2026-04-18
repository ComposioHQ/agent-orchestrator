## Adil — please reproduce the real-agent run on your machine (D3)

We need a second independent measurement before we commit to a reduction strategy. Below is the exact set of steps. Should take ~45 min wall-clock once setup is done.

### Goal

Spawn 5 real Claude Code agents on a small repo with real issues, let them run 30 min, and capture (a) GitHub rate-limit before/after, (b) every `gh` invocation the agents make. Compare to our numbers.

### Pre-flight checklist (one time)

1. **Branch + build.** On `feat/gh-rate-limiting`, latest commit:
   ```bash
   git checkout feat/gh-rate-limiting && git pull
   pnpm install && pnpm build
   ```
2. **Test repo.** Use a small repo you control with CI enabled. Either:
   - Fork `illegalcall/todo-app` (what I used; small Next.js app with typecheck/lint/build CI)
   - Or use any small repo of yours that has a CI workflow that runs on PRs (otherwise PR state never advances)
3. **AO config.** In your AO config dir, create or update `agent-orchestrator.yaml` to point at the test repo:
   ```yaml
   projectId: <your-test-repo-name>
   workspaceRoot: /absolute/path/to/test/repo
   tracker:
     plugin: github
     repo: <your-gh-username>/<test-repo>
   scm:
     plugin: github
     repo: <your-gh-username>/<test-repo>
   agent:
     plugin: claude-code
   runtime:
     plugin: tmux
   ```
4. **`gh` auth.** `gh auth status` — must be authenticated against the same account that owns the test repo, with `repo` and `workflow` scopes.
5. **`claude` CLI in PATH.** `which claude` should resolve. Sessions need a real Claude Code binary, not the placeholder shim our quiet-steady benchmark uses.
6. **Wait for our D1 patch to merge before running.** Without it the trace will be empty (this is exactly what happened to me on 2026-04-18). I'll comment when D1 is in.

### Seed issues

Use our seeding script (incremental complexity, 10 issues):

```bash
cd <agent-orchestrator-repo>
bash experiments/seed-issues.sh <your-gh-username>/<test-repo>
```

Note the issue numbers it creates (e.g., #103–#112). The benchmark will use the most recent 5.

### The run

Two terminals.

**Terminal A — start AO with tracing (both AO-side and agent-side):**
```bash
TS=$(date +%s)
TRACE_AO="$(pwd)/experiments/out/gh-trace-real-${TS}.jsonl"
TRACE_AGENT="$HOME/.ao/traces/agent-gh-$(date +%Y-%m-%d).jsonl"

# Make sure the agent-trace file exists / starts fresh:
mkdir -p "$HOME/.ao/traces"
: > "$TRACE_AGENT"

# Set BOTH trace env vars; D1's patched wrapper reads AO_AGENT_GH_TRACE
AO_GH_TRACE_FILE="$TRACE_AO" AO_AGENT_GH_TRACE="$TRACE_AGENT" \
  AO_CONFIG_PATH="$(pwd)/agent-orchestrator.yaml" \
  ao start
```

Leave it running. Verify it's polling — you should see `[GraphQL Batch Success]` lines in the AO log within ~30s.

**Terminal B — capture rate-limit, spawn 5 agents, wait, capture again:**
```bash
TS=$(date +%s)   # use the SAME TS as Terminal A
REPO=<your-gh-username>/<test-repo>

# Capture rate-limit BEFORE
gh api 'rate_limit' > "experiments/out/ratelimit-before-${TS}.json"

# Pick 5 most recent open issues
ISSUES=$(gh api "repos/${REPO}/issues?state=open&per_page=5" -q '.[].number')
echo "Issues to spawn: $ISSUES"

# Spawn one session per issue
for n in $ISSUES; do
  ao spawn $n
  sleep 5   # stagger so AO sees them as separate spawn events
done

# Wait 30 minutes (no early exit even if all PRs land)
sleep 1800

# Capture rate-limit AFTER
gh api 'rate_limit' > "experiments/out/ratelimit-after-${TS}.json"

# Show the deltas
echo "=== GraphQL ==="
jq '.resources.graphql' "experiments/out/ratelimit-before-${TS}.json"
jq '.resources.graphql' "experiments/out/ratelimit-after-${TS}.json"
echo "=== Core ==="
jq '.resources.core' "experiments/out/ratelimit-before-${TS}.json"
jq '.resources.core' "experiments/out/ratelimit-after-${TS}.json"
```

After 30 min, **stop AO** (Ctrl-C in Terminal A). The trace files are now complete.

### What to send back

Three things (paste in the PR or attach):

1. **Rate-limit deltas.** GraphQL `used` before/after, Core `used` before/after, computed pts/hr.
2. **Trace stats.**
   ```bash
   echo "AO-side rows:    $(wc -l < $TRACE_AO)"
   echo "Agent-side rows: $(wc -l < $TRACE_AGENT)"

   # Top 10 agent gh subcommands by count
   jq -r '.args | join(" ") | split(" ")[0:3] | join(" ")' "$TRACE_AGENT" \
     | sort | uniq -c | sort -rn | head -10
   ```
3. **Session outcomes.** How many of the 5 sessions reached `pr_open`, `ci_failed`, `mergeable`, `merged`. Quick way:
   ```bash
   for s in ~/.agent-orchestrator/*/sessions/*; do
     [ -f "$s" ] && grep -H ^status= "$s" | tail -1
   done | grep -E "(your test repo session-id pattern)"
   ```

### Sanity checks before you start

- [ ] `gh auth status` shows logged in
- [ ] AO config `agent-orchestrator.yaml` points at the test repo
- [ ] `which claude` resolves
- [ ] D1 wrapper is in `~/.ao/bin/gh` (check it has the trace logic; ours will land in commit XXXX — I'll comment)
- [ ] Test repo has a CI workflow that runs on `pull_request`
- [ ] Seed script created issues — confirm with `gh issue list -R <repo> --label benchmark`
- [ ] You have ~45 min uninterrupted to babysit the run

### What to expect

If your numbers match ours (~9000+ pts/hr GraphQL with 5 real agents), we know it's reproducible and not a quirk of my machine/account. If they're materially lower, we have a useful divergence to dig into (different Claude Code version? different agent prompt? different repo characteristics?).

Either way, the agent-side trace tells us **which gh subcommands consumed the budget**, which is the only data point that lets us decide between cache, prompt guidance, App tokens, or MCP migration.

### Ping

Reply on PR #1238 when you have results, or DM me if any step blocks. I'll move the rest of Track D forward in parallel.
