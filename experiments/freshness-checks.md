# Cache Freshness Check Runbook

**Purpose:** Validate that the in-process caches added in commits
`d4991601`, `c1067aa2`, `ab829fc8`, `70071390` don't cause meaningful
workflow lag when external state (PR, CI, reviews, issue) changes.

**What this answers:** "When something changes on GitHub *outside* AO's
own writes, does AO notice within the expected TTL window?"

**What this does NOT answer:** Total reduction (use `cache-replay.mjs`)
or scale headroom (use limit-finder).

---

## TTL contract under test

| Cached method | TTL | Max acceptable lag for external change |
|---|---:|---|
| `tracker-github.getIssue` / `isCompleted` | 5 min | Issue title/state/labels can lag up to 5 min |
| `scm-github.getPRState` | 5 s | PR open→merged/closed lag ≤ 5 s |
| `scm-github.getPRSummary` | 5 s | same |
| `scm-github.getCIChecks` | 5 s | CI flip pending→passing/failing lag ≤ 5 s |
| `scm-github.getMergeability` | 5 s | conflicts/mergeable lag ≤ 5 s |
| `scm-github.getReviews` | 10 s | new review lag ≤ 10 s |
| `scm-github.getReviewDecision` | 10 s | approval lag ≤ 10 s |
| `scm-github.getPendingComments` | 10 s | new review comment lag ≤ 10 s |
| `scm-github.detectPR` (positive) | 30 s | PR delete/transfer lag ≤ 30 s; PR-not-yet-created **not cached** |
| `scm-github.resolvePR` | 60 s | PR identity rename lag ≤ 60 s |

**Rule:** AO's lifecycle should observe the change within `TTL + one poll cycle`
(poll cycle is typically 30 s). Any gap larger than that is a regression.

---

## Setup (one-time per session)

Pick a test repo with at least one open issue + one existing open PR.
Examples below assume `illegalcall/todo-app`.

```bash
cd /path/to/test-project   # has agent-orchestrator.yaml
ao start                   # starts dashboard + lifecycle worker
```

Open the dashboard tab so you can observe state changes visually, and
tail the lifecycle log:

```bash
tail -f ~/.agent-orchestrator/<projectId>/logs/lifecycle.log
```

Spawn a session for an issue that already has an open PR (so PR-related
caches get exercised):

```bash
ao spawn --issue <NUM>     # waits for first poll cycle to attach the PR
```

Confirm the session shows `pr_open` (or similar) in the dashboard before
proceeding. From here on, each check below is independent.

---

## Check 1 — PR merge (`getPRState`, 5 s TTL)

**Trigger** (in another terminal):
```bash
START=$(date +%s)
gh pr merge <PR_NUM> --repo <owner/repo> --squash --delete-branch
echo "merge done at: $(date -u +%H:%M:%S)"
```

**Watch:** lifecycle log + dashboard. Wait for the session status to
flip from `pr_open` → `merged` (or `mergeable` → `merged`).

**Pass:** transition observed within 5 s + 30 s poll cycle = **≤ 35 s**.
**Fail:** > 35 s, or never.

Typical observed lag: 5–10 s if the merge happens just after a poll cycle,
up to ~35 s if it happens just before.

---

## Check 2 — CI flip (`getCIChecks` / `getCISummary`, 5 s TTL)

Hardest to trigger manually. Use a PR with checks already attached.
Easiest: re-run a failing check via `gh` to flip its state.

**Trigger:**
```bash
gh run rerun <RUN_ID> --repo <owner/repo>
# or push an empty commit to the PR branch and wait
```

**Watch:** lifecycle log for `ciStatus` changes; dashboard CI badge.

**Pass:** observed within ≤ 35 s of CI completing.
**Note:** GitHub itself takes time to update check status — exclude that
from the AO measurement. The clock starts when `gh pr checks <PR>` shows
the new state from your shell.

---

## Check 3 — New review comment (`getPendingComments`, 10 s TTL)

**Trigger:**
```bash
gh api -X POST "repos/<owner/repo>/pulls/<PR>/comments" \
  -f body="freshness check $(date +%s)" \
  -f commit_id=$(gh pr view <PR> --json headRefOid -q .headRefOid) \
  -f path=README.md \
  -F line=1 \
  -F side=RIGHT
```

**Watch:** dashboard `review_pending` indicator or lifecycle log
`unresolvedComments` count.

**Pass:** observed within ≤ 40 s (10 s TTL + 30 s poll cycle).

---

## Check 4 — PR approval (`getReviewDecision` + `getReviews`, 10 s TTL)

**Trigger** (must be from a different GitHub account than the PR author):
```bash
gh pr review <PR> --repo <owner/repo> --approve --body "freshness check"
```

**Watch:** lifecycle log for `reviewDecision: approved`; dashboard
"approved" badge.

**Pass:** observed within ≤ 40 s.

---

## Check 5 — Issue close (`tracker-github.isCompleted`, 5 min TTL)

**The arguable one.** This is the cache the user explicitly flagged.

**Trigger:**
```bash
gh issue close <ISSUE_NUM> --repo <owner/repo> --reason completed
```

**Watch:** lifecycle log for the session's cleanup decision; dashboard
`completed` / archived state.

**Pass:** observed within ≤ 5 min + 30 s poll cycle = **≤ 5.5 min**.

If this is too slow for the workflow, drop the TTL to ~60 s in
`tracker-github/src/index.ts` (`ISSUE_CACHE_TTL_MS`). Trace replay would
need to be re-run at that TTL — `getIssue` hit rate of 93.7% at 5 min
would drop somewhat at 60 s, but most issue-view duplicates are clustered
within a single poll cycle so the drop should be modest (rough estimate:
93% → 70-80%).

---

## Check 6 — detectPR new-PR discovery (positive-only, no negative cache)

**Setup:** a session whose branch has NO PR yet.

**Trigger:**
```bash
gh pr create --repo <owner/repo> --head <session-branch> --title "freshness check" --body ""
```

**Watch:** dashboard for the session transitioning from `working` →
`pr_open` (or equivalent — the moment AO recognises the new PR).

**Pass:** observed within **one poll cycle (~30 s)**. No cache delay
because empty `detectPR` results are never cached.

---

## Check 7 — AO-internal mutations (sanity)

Verifies our own writes invalidate immediately (this is the contract
that's *easiest* to break in future code):

**Trigger** (from inside an AO context, not directly):
- Use the dashboard to merge a PR, OR
- Ask an agent to call `mergePR` via its workflow.

**Pass:** the session immediately reflects merged state on the very next
poll (no waiting for any TTL). If you see a 5+ second lag here, it
means `mergePR`/`closePR` invalidation broke — file a regression
immediately.

---

## What to record

For each check, capture:

```
Check: <name>
Trigger time:        HH:MM:SS
Observed reaction:   HH:MM:SS
Lag:                 <seconds>
TTL contract:        <max acceptable seconds>
Pass/Fail:           PASS or FAIL
Notes:               (e.g., "first poll just after trigger, fast" or "edge of window")
```

Aggregate into a small markdown table at the bottom of this doc once
the run is complete.

---

## Expected outcomes

If all checks 1–7 pass, the cache changes are validated against the
freshness contract. Adil's planned Steps 1/2/5 (which obsolete some of
these caches at the lifecycle layer) become a *separate* workflow
correctness question, not a freshness one.

If any check **fails** by a large margin (> 2× the TTL contract), suspect:
- A poll-cycle bug (lifecycle worker stalled or polling slower than expected)
- A stale-cache invalidation bug (write didn't invalidate)
- An external-actor blindness scenario the cache spec doesn't cover

If checks fail by a small margin (just over TTL), it's likely
poll-cycle phase rather than cache misbehavior — re-run the check 3-5
times to get a stable reading.
