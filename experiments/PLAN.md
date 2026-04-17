# GitHub Rate-Limiting: Plan Forward

**Branch:** `feat/gh-rate-limiting`
**Date:** 2026-04-14
**Status:** Draft v2.3 — for iteration before any commit/push

---

## Problem

AO needs to support **≥50 concurrent sessions** against a single GitHub PAT (5000 requests/hour REST core, 5000 points/hour GraphQL). The current polling model already has some batch enrichment and throttling in place, so the real question is not "how much does naive per-session polling cost" but **which specific hot spots actually eat the budget**. The hot spots we suspect, based on the lifecycle doc and Experiment 1:

- **Broken ETag guard** — `gh api`'s exit code 1 on `304` makes AO treat successful conditional requests as errors and fall back to full-cost reads. Silent no-op today.
- **Per-PR Guard 2 steady state** — commit-status polling per open PR per poll cycle. Scales with live-PR count.
- **`detectPR` fan-out in a single repo** — N sessions on the same repo each spawn their own `gh pr list --head <branch>` subprocess every cycle.
- **Review backlog bursts** — when a reviewer leaves a batch of comments, AO's reaction path can produce a burst of reads/writes in a narrow window.
- **Cold-start / cache-miss storms** — after restart every session re-fetches everything at once.

Under Track A below we **measure** these. Under Tracks B/C we **fix** them, with before/after traces attached to every change.

## Secondary concern

We also need to stay safely under GitHub's documented secondary limits: ≈100 concurrent requests, ≈900 points/min writes, ≈80 content-generation requests/min. Experiment 3 could not provoke these at 200-wide bursts against `/user`, but that just means we can't use the harness to trigger them — we still have to instrument peak in-flight count and burst shape to know when we're approaching the cliff we can't probe.

---

## Reference material in this branch

Under `experiments/`:

1. **`ao-lifecycle-gh-cli-interactions.md`** — AO's documented polling architecture, the full set of `gh` CLI calls across 5 phases. Source of truth for "what AO actually calls today."
2. **`gh-etag-verification-experiment-codex.md`** — Codex's independent ETag verification. Proves `gh` forwards `If-None-Match`, GitHub returns real `304`s, but `gh` **exits with code `1`** on success. Also finds `gh` and `curl` produce different ETag strings for the same resource (weak vs strong validator), so ETags are transport-specific.
3. **`2026-04-14-etag-verification.md`** — Our own experiment doc covering REST ETag (Experiment 1), GraphQL ETag + alias batching (Experiment 2), and secondary-limit stress (Experiment 3).

---

## Experiments completed

### Experiment 1 — REST ETag guard (replication of Codex's finding)

- `gh api -i` forwards `If-None-Match` and surfaces `304 Not Modified`.
- `gh api` exits with **code 1** on successful `304`. `execFileAsync` in Node treats that as a thrown error.
- `x-ratelimit-remaining` is unchanged across `200 → 304`, so the primary bucket truly is not decremented.
- The ETag guard in `scm-github/graphql-batch.ts` has **two bugs** that make it a silent no-op:
  1. The catch branch for the non-zero exit code does not recognize `304` and treats it as a hard failure.
  2. Status parsing uses a substring match that does not match `HTTP/2.0` with the extra `.0`.

**Implication:** AO has been paying full cost for every "conditional" call. The guard is dead code.

### Experiment 2 — GraphQL conditional requests + aliased batching

- **G1** — No `etag` header on `/graphql` POST responses.
- **G2** — Replaying a synthetic `If-None-Match` returns `200 OK` with bucket decrement. GitHub ignores conditional requests on `/graphql`.
- **G3** — A 3-alias primary-key batch (`pr1/pr2/pr3` each `repository(...).pullRequest(number: N)`) costs **exactly 1 point**. `remaining: 7 → 8 → 9 → 10` across three distinct calls.
- **G4** — `rateLimit { cost remaining resetAt }` is free to include and matches header delta.
- **G4b bonus** — A 25-alias batch also costs **1 point**. `remaining: 13 → 14 → 15 → 16`.

**Implications:** persistent GraphQL ETag cache is dead. Aliased primary-key batching is the main graphql lever. In-body `rateLimit { ... }` is the free attribution signal and the harness should request it on every graphql call.

### Experiment 3 — Secondary rate limits

Bursts of `N = 20, 60, 120, 200` via `gh api /user` in parallel and `N = 150` via direct `curl`: 0 failures, 0 `403`/`429`, ~550 real calls total. Also found `/rate_limit` lags real bucket state — trust per-response `x-ratelimit-*` headers.

**Implications:** we cannot trigger secondary limits in a harness at our scale. We plan optimizations against documented limits while instrumenting peak in-flight count and burst shape so we can detect proximity empirically.

---

## What we have NOT done

- No bug fixes yet. Deliberate: baseline-first so fixes land with before/after numbers.
- No Octokit. The current reality is `gh` subprocess. Measure that first.
- No harness. Every number so far is ad-hoc shell in `/tmp`.
- No verification of current batch-enrichment coverage across phases. One of the things the harness must confirm.

---

## Plan forward — two tracks, phased

The most important structural change from v1: **the baseline recorder (Track A) and any behavior-changing work (Track B) are strictly separated.** Track A ships first, unchanged behavior, just instrumentation. Only after we have baseline numbers does Track B start landing fixes.

### Progress & Status (updated 2026-04-17)

**Tracks are strictly sequential:** A → B → C. Each track depends on the previous track's output.

```
Track A ── Measure ──────────────────────────────────────────────────────
  A1a  Ship execGhObserved() + JSONL recorder        ✅ Done (PR #1238)
  A1b  Fix tracer blind spots (5 blockers)            ✅ Done (blockers 1-4 fixed, #5 deferred)
  A2   Benchmark harness + baseline data              ✅ Done — harness built, 5-session baseline captured
       Scorecard: experiments/out/scorecard-quiet-steady.single-repo.5-*.json

Track B ── Fix bugs ─────────────────────────────────────────────────────
  B1   Safe behavioral fixes (304, status parsing)    ✅ Done (cd0b16ca, pushed, PR #1238)
       — ETag 304-as-error fix in graphql-batch.ts
       — is304() + extractErrorOutput() helpers
       — rateLimit { cost remaining resetAt } added to batch query
       — Verified: 100% guard 304 rate, 0 graphql-batch calls in quiet-steady
       — Awaiting Adil's independent verification (PR comment posted)
  B2   Structural reductions (detectPR dedup, batch)  ⏳ Blocked on B1 verification
  B3   Scale-up validation (5→50 sessions)             ✅ Done — full capacity discovery complete
       5→260, 10→640, 20→680, 30→900, 40→1140, 50→~1400 GraphQL pts/hr
       Rate limit target MET: 50 sessions = ~28% of GraphQL budget
       ETag guard 304 rate: 100% at every scale, 0 batch calls
       First bottleneck: poll cycle lag (66s at 50 sessions vs 30s target)
       Second bottleneck: API latency (p50=3.4s, p99=9.7s at 50 sessions)
       B2 structural reductions NOT required for quiet-steady rate limits
  B4   Poll cycle optimization (NEW)                  ⏳ Next — lifecycle processes sessions sequentially

Track C ── Octokit migration (optional) ─────────────────────────────────
  C1   OctokitRunner behind flag + compare            ⏳ Blocked on B scorecard
```

**Why sequential:**
- **A before B:** B fixes bugs, but without A's baseline numbers there's no "before" to prove the fix helped. Every B fix lands with a before/after trace delta.
- **B before C:** B tells us which call patterns are hot and which optimizations matter. Migrating to Octokit without that data means guessing.

**A1b blockers (owner / status):**

| # | Blocker | Owner | Status |
|---|---------|-------|--------|
| 1 | `graphql-batch.ts:578` — add `-i`, split headers/body | us | ✅ |
| 2 | `extractOperation()` — skip `-*` flags | us | ✅ |
| 3 | Analyzers — segment burn by `rateLimitReset` window | us | ✅ |
| 4 | Gap 1 decision — accept opaque, bracket with `/rate_limit` | us | ✅ |
| 5 | `sessionId`/`projectId` threading through callsites | deferred | ⏳ |

**Parallel work while A1b lands:** A2 scenario matrix design (scenarios, topologies, scale points, pruning rules) can be drafted now since it doesn't depend on A1b code.

**After A1b code lands:** @whoisasx reruns a clean trace inside a single rate-limit reset window (~45 min max), pastes analyzer output, and A1b is closed.

**A1b verification results (2026-04-16):** Two independent runs completed — Adil's A1b rerun (974 calls, 33 min, 5 sessions) and our verification run (234 calls, 22 min, 6 sessions). Both confirm:
- `graphql-batch` is the dominant measured budget consumer: **820–1,416 tokens/hr at 5 sessions** (per-window measurement)
- REST core burn is negligible: **28 tokens/hr** at 5 sessions
- Bug #1 (304-as-error) causes most guard-pr-list calls to be treated as changes, driving unnecessary `graphql-batch` calls
- Bug #1 is the first high-confidence cause to remove (Track B1)
- Full data captured in `experiments/baseline.md` (cell S2-T1-5)

---

### Track A — Baseline recorder

**Goal:** replace every `gh` invocation in AO with a thin command-oriented wrapper that records a JSONL trace entry, **without changing any observable behavior**. Produce a summary tool. Collect real traces. That is all Track A does.

#### Phase A1 — Wrapper + recorder + summary tool

1. **New package** — lean: `@aoagents/ao-gh-transport` (separate package keeps core small and gives the harness its own tests and release cadence). Location is open question #3 below — a first-patch implementation choice, not a Phase A1 blocker.
2. **Command-oriented wrapper interface** — drop-in for today's `execFile("gh", ...)` calls:
   ```ts
   export interface GhRunner {
     // Resolves with GhResult on exit 0. On non-zero exit or timeout, rejects
     // with a GhRunnerError (see below) whose fields match today's
     // execFileAsync rejection shape in the places current callers inspect.
     run(invocation: GhInvocation): Promise<GhResult>;
   }

   export type GhInvocation = {
     args: string[];                 // e.g. ["api", "-i", "repos/foo/bar/pulls/1"]
     cwd?: string;
     input?: string;                 // stdin (e.g. graphql query body)
     env?: Record<string, string>;
     attribution: {
       projectId: string;
       sessionId?: string;
       phase: string;                // "spawning" | "working" | "pr_open" | "cleanup" | "dashboard" | ...
       source: string;               // format: "<plugin>.<module>.<operation>", e.g. "scm-github.batch.guard1"
       cycleId?: string;             // opaque id shared by all calls in one poll cycle
     };
   };

   export type GhResult = {
     // Raw — exactly what the subprocess produced
     args: string[];
     stdout: string;
     stderr: string;
     exitCode: number;
     durationMs: number;
     startedAt: number;              // unix ms
     endedAt: number;                // unix ms

     // Parsed — best-effort, null when not applicable
     parsed: {
       status?: number;              // parsed from HTTP/x.y nnn line (tolerates HTTP/1.1, HTTP/2, HTTP/2.0)
       etag?: string;
       notModified?: boolean;        // true iff status === 304
       rateLimit?: {
         resource: string;           // "core" | "graphql" | "search" | ...
         limit: number;
         remaining: number;
         used: number;
         resetAt: number;            // unix seconds
       };
       graphqlCost?: {               // only if the response body contained `rateLimit { cost remaining resetAt }`
         cost: number;
         remaining: number;
         resetAt: string;
       };
       retryAfterSec?: number;       // secondary-limit signal
     };
   };

   // On non-zero exit (including gh's exit-1-on-304) or timeout, run() rejects
   // with an error that is compatible with today's execFileAsync rejection in
   // the fields current AO callers actually inspect: same constructor name,
   // numeric .code, .stdout, .stderr, and a .message that starts with the
   // same "Command failed: ..." prefix. Stack traces and internal properties
   // may differ. The error carries one extra field: .ghResult with the full
   // parsed block, so recorders and callers can still inspect
   // status/headers/etag on the failure path.
   export interface GhRunnerError extends Error {
     code: number;                   // subprocess exit code (1 for 304, etc.)
     stdout: string;
     stderr: string;
     ghResult: GhResult;             // full parsed block, identical to success-path shape
   }
   ```
   **Critical: this wrapper preserves current error semantics.** On success (exit 0), `run()` resolves with a fully populated `GhResult`. **On non-zero exit or timeout, `run()` rejects** — matching today's `execFileAsync("gh", ...)` rejection in the fields current callers rely on: constructor `name`, numeric `.code`, `.stdout`, `.stderr`, and a `.message` with the same `"Command failed: ..."` prefix. Stack traces and internal Node properties are not held to byte-level parity — implementers shouldn't rewrite message suffixes or construct a novel `Error` subclass from scratch, but they also shouldn't chase string-equality on frames. The only real addition is the `.ghResult` field on the rejected error, so recorders can still capture parsed status/headers/etag on the failure path (notably gh's exit-1-on-`304` case). Existing `try/catch`/`.catch()` at every call site continues to work without changes. The wrapper does **not** normalize `304` into a resolved success, does **not** flatten exit codes, does **not** invent a new error shape. Caller-side misclassification of `304` and substring status parsing are Track B fixes — not Track A's job.
3. **Raw-plus-normalized is a stated design rule, not an accident of the type.** Every `GhResult` preserves the raw subprocess output (`args`, `stdout`, `stderr`, `exitCode`, `durationMs`, `startedAt`, `endedAt`) alongside a best-effort `parsed` block. New call sites MUST NOT drop raw fields when they add new parsing. Rationale: debuggability, forward-compat for schema evolution, and a way to re-derive any parser bug after the fact without re-running the scenario.
4. **Two recording modes, both default off in Phase A1.**
   - **Counters mode (light).** In-memory, bounded, O(1) per call. Tracks the reduced set a summary can be built from: per-phase/per-source request count, status split, exit-code split, `x-ratelimit-remaining` floor per resource, max observed in-flight, burst shape bucketed per 1s/5s/10s. Periodically flushed to a small rotating file (`~/.agent-orchestrator/traces/gh-counters-YYYY-MM-DD.json`) and surfaced via an API route for the dashboard later. No raw request bodies, no stdout capture, no PII risk. Safe to leave on always once the schema stabilizes — but **off in Phase A1** so we ship the wrapper without implicitly committing to a retention story.
   - **Raw JSONL mode (heavy).** One full row per call appended to `~/.agent-orchestrator/traces/gh-YYYY-MM-DD.jsonl`. Includes raw stdout/stderr (truncated — see redaction rules below) and full parsed headers. This is the high-signal mode we actually run experiments against, and it's where the schema-sensitivity lives. **Off by default, enabled explicitly** for the Phase A2 matrix runs. Phase A1 ships env-only activation:
     - env var: `AO_GH_TRACE=1` or `AO_GH_TRACE_FILE=<path>`
     - **Config-file activation (`gh.trace: true` in `agent-orchestrator.yaml`) is deferred out of Phase A1.** Config schema work is plumbing, not wrapper work, and A1 is supposed to be near-mechanical. If deliberate-run friction from the env-only approach proves annoying, we add config support as a small follow-up patch.
   - Rationale for the split: continuous visibility is a legitimate want, but it's a different product than a baseline harness. Counters mode gives us the former without locking in a raw-trace retention story we haven't validated. We build both code paths in Phase A1 and leave both off.
5. **Global trace storage** — `~/.agent-orchestrator/traces/gh-YYYY-MM-DD.jsonl` (raw mode) and `~/.agent-orchestrator/traces/gh-counters-YYYY-MM-DD.json` (counters mode). Rate limits are per-token, not per-project, so both files span projects. Each raw row carries `projectId`, `sessionId`, `phase`, `source`, `cycleId` for slicing. Optional token-fingerprint keying (SHA-256 prefix of the token or the authenticated `login`) if we ever run multiple tokens on one machine — out of scope for Phase A1, but the schema reserves a nullable field now.
6. **Recording is best-effort.** A recorder failure (disk full, JSON stringify error, counters overflow) MUST NOT change the call outcome or throw back into the caller. The wrapper wraps recording in its own try/catch and logs recorder errors separately.
7. **Call-site migration** — `packages/plugins/scm-github/**` and `packages/plugins/tracker-github/**` replace every `execFile("gh", ...)` with `runner.run({ args, cwd, attribution })`. No other changes.
8. **Summary tool** — reads JSONL for a time range and prints:
   - Totals: request count, total duration, core budget spent, graphql points spent.
   - **Status split**: `200` / `304` / `4xx` / `5xx` / exit-code-nonzero counts.
   - **Per phase** breakdown (`spawning` / `working` / `pr_open` / `cleanup` / `dashboard` / ...).
   - **Per source** breakdown. `source` follows a fixed format so per-source cardinality stays sane: **`<plugin>.<module>.<operation>`**. Examples: `scm-github.batch.guard1`, `scm-github.detectPR.list`, `scm-github.pr.view`, `tracker-github.issue.get`, `tracker-github.issue.list`. New call sites must pick existing module/operation names when the semantics match rather than inventing a fresh string. Free-form underneath (summary tool treats it as opaque), but the convention keeps the summary readable.
   - **Per session** and **per repo** breakdowns.
   - **`x-ratelimit-remaining` floor** over the window (REST core and graphql separately).
   - **Any `4xx`/`5xx`/`Retry-After`** surfaced as a list, not a count.
   - **Peak observed concurrency** computed from overlapping `[startedAt, endedAt]` intervals — not just a max-parallel counter. This is the secondary-limit proximity metric.
   - **Burst shape** — max requests-per-second over 1s/5s/10s windows.
   - **Waste metrics**:
     - **Duplicates within a `cycleId`** — same `args` (or same parsed endpoint) called twice in one cycle, per session and per repo.
     - **Ignored-result candidates** — calls whose result was immediately superseded by the next poll cycle (heuristic: identical `args` within less than one poll interval).
     - **Cold-start storms** — request count in the first 60s after the trace stream starts.
     - **ETag guard effectiveness (transport-level only in Track A).** Track A measures exactly one metric: **`conditional_304_rate`** — fraction of calls that sent `If-None-Match` and where the transport surfaced `status === 304`. Because `run()` rejects on `gh`'s exit-1-on-304, this is computed by walking *all* trace rows (success and failure) and checking `parsed.status === 304`; the rejected-path row still has the full parsed block via `error.ghResult`. This is the **GitHub/gh truth**: did the server tell us "unchanged"? On current (buggy) v2.1 code we expect this rate to be non-trivial on PR list / commit status endpoints — which is itself the evidence that the transport is doing its job and the caller is throwing the result away. **Caller-level cache-hit rate is deferred to Phase B1.** The 304-handling fix naturally inserts a cache decision at the call site, and at that point a `conditional_cache_hit_rate` metric can be produced cleanly — either by tagging the follow-up action into a new trace row or by emitting a counter alongside. Track A deliberately does not try to thread a caller decision back into an append-only JSONL row that's already been written; that mechanism was underdesigned in v2.2 and is cut here. Divergence between transport rate (measured in A) and caller-level hit rate (measured in B) across the fix boundary is the before/after evidence that Bugs #1 and #2 were dead; post-fix convergence is the evidence that they're dead in the other direction.

**Exit criterion:** running AO end-to-end against a real repo with raw-mode tracing enabled produces a trace file that the summary tool renders, and the migration PR introduces **no intentional semantic change in success/failure decisions, cache behavior, or state transitions.** We deliberately do not bar-test this via output-diffing — tracing adds syscalls and disk writes, so timing will shift and any diff-based acceptance test would chase flakes. Instead we enforce the bar via a code-review checklist applied to every call-site migration:

- Does this diff change any `if (exitCode !== 0)` / status-handling branch?
- Does it change any cache key or cache-hit/miss condition?
- Does it change any lifecycle state transition or retry decision?
- Does it change any error shape propagated to callers?

If all four answers are "no," the migration passes the behavior-delta bar. Actual behavior fixes (304 handling, status parsing) happen in Track B, where the diffs are small and the trace delta is the evidence.

**The code-review checklist is necessary but not sufficient.** Review catches intent-level regressions; it misses the wrapper's own failure modes — buffering, stdin wiring, timeout propagation, env merging, error-object shape. Phase A1 ships with one automated acceptance bar alongside the checklist:

1. **Golden tests on `GhSubprocessRunner`.** Run against a scripted fake `gh` binary (a small shell/node script that produces deterministic outputs). Cover:
   - **success path** — exit 0, status `200 OK`, populated headers including `x-ratelimit-*`, known body. Assert `run()` resolves with a `GhResult` whose raw fields round-trip exactly and whose `parsed` block is populated correctly.
   - **conditional `304`** — exit **1**, status `304 Not Modified`, `x-ratelimit-remaining` unchanged. Assert that `run()` **rejects** with a `GhRunnerError`, `error.code === 1`, the error shape matches today's `execFileAsync` rejection (same `name`, same `.stdout`/`.stderr`/`.message` layout), `error.ghResult.parsed.status === 304`, `error.ghResult.parsed.notModified === true`, and `error.ghResult.parsed.rateLimit.remaining` equals the pre-call value. Assert that a trace row for the call is still recorded (recorder runs on both the resolve and reject paths).
   - **timeout** — fake binary sleeps past a configured timeout. Assert `run()` rejects with the same error shape today's `execFileAsync` produces on timeout (including `.killed` / ETIMEDOUT semantics), `error.ghResult` is present with whatever bytes were captured before the kill, and a partial trace row is still written.
   - **large stdout/stderr** — fake binary emits >1 MB on each stream. The wrapper configures an explicit `maxBuffer` (≈10 MB — well above the default 1 MB `execFileAsync` limit) so normal large-but-not-pathological responses do not trigger `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. Assert: no subprocess crash at 1 MB; the `parsed` block is fully populated from the early bytes (headers parse correctly regardless of body size); the recorder applies the 64 KB stdout cap from the redaction rules below; the row records a `stdoutTruncatedBytes` field equal to the number of dropped bytes; and at output sizes beyond the configured `maxBuffer` the wrapper produces a controlled rejection identical in shape to today's `execFileAsync` overflow error, not a crash. (There is intentionally no "no truncation in raw storage" assertion — raw storage is capped, by design.)
   - **non-zero exit with error on stderr** — fake binary emits an authentication-style error to stderr and exits with code 4. Assert `run()` **rejects**, `error.code === 4`, `error.stderr` equals the raw stderr, the rejection matches today's `execFileAsync` shape in the fields callers rely on (`name`, `.code`, `.stdout`, `.stderr`, `.message` prefix), `error.ghResult.stderr` is populated identically, `error.ghResult.parsed.status` is `undefined`, and a trace row is recorded with `exitCode: 4` and the stderr body preserved.
2. **One real smoke run.** Start AO end-to-end against a real fixture repo with one session, **tracing off**. Verify the session reaches the same lifecycle states it reaches on `main` (same phase progression, same PR creation, same terminal progression). This is the one concrete check that no semantic regression slipped through review.

Both are cheap, both are deterministic, both fail fast. If either fails, the wrapper does not ship.

**Privacy, redaction, and retention for raw JSONL mode.**

Counters mode is aggregated-only and inherently low-risk: numbers per phase/source/resource, no raw fields. Raw JSONL is the sensitive one. Before Phase A2 opens tracing on real runs, the recorder enforces:

- **Stdout truncation.** Default cap: **64 KB per row**, applied after parsing so the `parsed` block is always complete. Overflow is noted with a `stdoutTruncatedBytes` field; the raw body beyond the cap is dropped, not tail-trimmed into the middle of a structure.
- **Stderr captured in full.** Small in practice, high-value for debugging failed runs.
- **GraphQL query text logged in full.** Queries are structural, not PII — they describe the shape of what AO asked for, not the content that came back. This is the field we most want for cost attribution and alias-batching analysis.
- **Comment-body redaction pass.** When the response body contains a known comment-carrying JSON field (`body`, `body_text`, `body_html` under `comments`, `review_comments`, or GraphQL `pullRequestReview.body`), the recorder replaces the value with `"[redacted: <N> chars]"` before writing. The list of fields is explicit; unknown shapes pass through unredacted. Rationale: comment bodies are user-generated text that can contain anything (names, secrets pasted into comments, unrelated business content), and the harness has no analytical need for them — cost attribution needs counts, not content.
- **Repo/branch/issue-title names are NOT redacted.** They're load-bearing for slicing traces per repo and per PR, and they're already visible in the `args` anyway. Anyone with access to `~/.agent-orchestrator/traces/` already has access to AO's config.
- **Token never appears.** `gh` never puts the token in `args` or on stderr under normal operation. The wrapper scrubs any `Authorization:` header substring defensively before writing. Token fingerprint is a separate nullable field, populated only if we ever need multi-token slicing.
- **Retention.** Raw JSONL rotates daily and auto-prunes at **7 days** by default. Experiment runs that need longer retention copy the files out explicitly. Counters mode rotates daily and prunes at 30 days.
- **Location is local only.** Traces live under `~/.agent-orchestrator/traces/` and are never uploaded, synced, or shipped anywhere by the harness. The dashboard may read them locally in a follow-up phase; that's the extent of their reach.

These rules are enforced by the recorder, not by convention. The recorder **splits the raw stdout at the first blank line** before any redaction runs: everything above is the HTTP header block (status line, `etag`, `x-ratelimit-*`, `retry-after`, etc.) and is preserved verbatim; everything below is the response body and is the only region subject to comment-body redaction or drop-on-failure. If the recorder cannot apply redaction to the body (for example, because the response is not valid JSON), it drops the body portion entirely and writes the row with a `redactionFailed: true` flag — **headers are still preserved in that case** because they carry the rate-limit and ETag signals the harness exists to capture. `redactionFailed` applies to the body only; it never suppresses headers.

**A1a validation status (2026-04-16).** The shipped A1a tracer (PR #1238) was validated two ways: (1) against @whoisasx's 974-row baseline trace and his follow-up 1,487-row run, and (2) against an independent `execGhObserved` drill (`experiments/drill-tracer.mjs` + `experiments/analyze-trace.mjs`) run locally against a public repo. The schema shape is sound and carries more than we were using — `rateLimitReset` is already declared at `packages/core/src/gh-trace.ts:48` and populated from the `x-ratelimit-reset` header at `:185`, and it's present on every rate-limit-bearing row in Adil's traces. The gaps that block freezing A1 and opening A2 are at the **callsite** and **analyzer** layers, not in the row schema:

1. **`executeBatchQuery` does not pass `-i`.** `packages/plugins/scm-github/src/graphql-batch.ts:578` builds `["api", "graphql", ...varArgs, "-f", "query=..."]` with no `-i`, so every `gh.api.graphql-batch` row has `httpStatus=none` and zero rate-limit headers. In Adil's 1,487-row run that's 186 batch calls — the single hottest explicitly-named `api` callsite — completely invisible to status and rate-limit analysis. Must add `-i` and split the header prefix from the JSON body before parsing (same treatment as `checkPRListETag`).
2. **`extractOperation()` flag handling is broken.** `packages/core/src/gh-trace.ts:68` returns `gh.${args[0]}.${args[1]}`, which buckets any `gh api --method GET ...` call under `gh.api.--method` (124 rows in Adil's latest run). Fix is to skip leading `-*` flags when picking the operation segment.
3. **Analyzer does not segment by reset window.** Neither `experiments/summarize-gh-trace.mjs` nor `experiments/analyze-trace.mjs` uses `rateLimitReset` to split the burn calculation. Any run that straddles a reset (Adil's 50-min run crossed 20:00 UTC) produces a naive `first - last` delta that is mathematically meaningless. This is an analyzer patch — the field is already on every row.
4. **CLI-subcommand HTTP visibility gap — DECIDED: accept opaque for A1.** `gh pr view/list/checks` and `gh issue view/list` never expose HTTP responses in stdout (~53% of calls in Adil's run). Options were (a) parse `GH_DEBUG=api` stderr for per-call visibility, or (b) accept subcommands as opaque and bracket runs with `/rate_limit` snapshots for coarse total burn only. **Decision (2026-04-16): option (b) — accept opaque.** Rationale: `GH_DEBUG=api` stderr is undocumented, version-fragile, and mixes with real error output — parsing it adds tracer complexity that Track C (Octokit migration) would delete. `/rate_limit` snapshots are lagged (per Experiment 1, line 62) and don't give per-call 200/304 split, but they answer the A2 question "did subcommands collectively cost more than expected?" which is sufficient for baseline. If Track B analysis shows subcommands are a significant budget fraction, `GH_DEBUG` parsing can be added with real evidence it's needed. A2 runs will bracket each scenario with a start/end `/rate_limit` snapshot and note the coarse delta alongside the per-call trace.
5. **`sessionId`/`projectId` never threaded through plugin callsites.** `GhTraceContext` supports them, but the three migrated callsites in `scm-github` and `tracker-github` pass only `component`/`operation`. Without these, per-session attribution — the whole point of the `<plugin>.<module>.<operation>` naming rule above — is not achievable in practice. A1b must thread the session/project IDs from the lifecycle manager into the plugin methods that call `execGhObserved`.

**Known-open, not a freeze blocker.** The bare `gh()` helper at `packages/plugins/scm-github/src/index.ts:80` passes `{ component: "scm-github" }` with no `-i` and no `operation`. Two scm-github callsites route through it: `getPendingComments` at `index.ts:780` (the 198 `gh.api.graphql` rows) and review-comment pagination at `index.ts:882` (the 124 `gh.api.--method` rows). Fixing the helper to inject `-i`, strip the header prefix before returning body-only, and require an `operation` argument would close both buckets, but it carries parser-audit risk across ~15 callers and should not be conflated with the A1b freeze. File as a follow-up after A1b lands.

Re-running A2 before blockers 1–5 are closed will produce another baseline where the batch call is invisible, the hot subcommand calls are either unattributable or unresolved, per-session attribution is missing, and the burn number is a naive cross-reset delta — which is exactly the set of signals A2 exists to measure.

#### Phase A2 — Baseline scenario × scale × topology matrix

Scale alone is not enough, and neither is scenario alone. Some hot spots (notably `detectPR` fan-out and same-repo batch reuse) are **topology-sensitive** — they only show up when many sessions share a repo. Others (cold-start storms, review backlog bursts) are **scenario-sensitive**. The matrix has to cross all three axes explicitly or the baseline can look healthy while hiding the exact shape we're trying to optimize.

**Scenario axis:**

| Scenario | What it exercises |
|---|---|
| **Cold start after restart** | Cache-miss storm, every session re-fetching from scratch. |
| **Quiet steady state** | Long run with no events. Pure polling floor per session. |
| **Spawn storm** | N sessions launched within a ≈30s window. `spawning`-phase burst. |
| **Review backlog burst** | Reviewer leaves a batch of comments on M PRs simultaneously. AO reaction path. |
| **Cache-miss / fallback path** | Artificially flush any in-process cache mid-run and observe recovery cost. |
| **Dashboard/API enrichment load** | Dashboard open with users clicking around; separate attribution tag from lifecycle traffic. |

**Topology axis:**

| Topology | What it exercises |
|---|---|
| **Concentrated (single-repo)** | All N sessions on one repo. `detectPR` fan-out, repo-batch reuse, same-repo cache coalescing. This is where structural reductions in Phase B2 do their work. |
| **Spread (multi-repo)** | N sessions split across ≈N/5 repos (minimum 2). Realistic mixed workload, representative of users running AO across several projects. Cross-checks that per-repo optimizations don't accidentally pessimize the non-same-repo case. |

**Scale axis:** 1, 5, 10, 25, 50 sessions. Scales below 5 are meaningless for topology (can't spread 1 session across repos), so the spread topology only runs at 5/10/25/50.

**Full matrix** is 6 scenarios × 2 topologies × (up to) 5 scales ≈ 54 cells. That's a lot of short runs, and many cells will be redundant (quiet steady state at 1 session tells us nothing new at 5). **Pruning rule**: run the full matrix once at the start of Phase A2, then keep only the cells that show meaningfully different numbers from their neighbors. The final `experiments/baseline.md` will have ~20–30 cells, not 54.

Output: `experiments/baseline.md` with one subsection per (scenario, topology, scale) cell, each containing the summary-tool output and a one-line "what this cell tells us" annotation. This is the single artifact that gates Track B.

---

### Track B — Smallest, highest-confidence fixes

Only starts after `experiments/baseline.md` is filled in. Each fix lands as its own PR with before/after trace summaries in the description.

#### Phase B1 — Safe behavioral fixes

1. **ETag `304` handling** — catch the `exitCode === 1 && parsedStatus === 304` case in the scm-github ETag guard. Smallest possible change, localized to the existing guard in `scm-github/graphql-batch.ts`.
2. **Status parsing robustness** — fix the substring match so `HTTP/2.0 304` is recognized, not just `HTTP/2 304`.
3. **GraphQL in-body `rateLimit` instrumentation** — add `rateLimit { cost remaining resetAt }` to every graphql query AO sends. The wrapper already parses it; we just have to ask for it. Free cost attribution.
4. **Global subprocess concurrency cap** — a semaphore around `runner.run()` limited to a configurable max. Stops burst shape from pressing the secondary-limit cliff. Initial cap set conservatively below the documented ≈100 concurrent guideline.

These are cheap, localized, independently reversible, and each produces a measurable trace delta.

#### Phase B2 — Structural reductions

Landed one at a time, each gated by a trace delta from baseline.

1. **Repo-level `detectPR` collapse per poll cycle.** Today, multiple sessions on the same repo each spawn their own `gh pr list --head <branch>` call. Collapse all same-repo detectPR calls in one cycle into a single repo-wide fetch, then serve every session from the shared result. Expected: largest single reduction in `working`-phase cost for multi-session repos.
2. **Measure and expand current batch-data reuse.** AO already has batch enrichment — the harness will show us which phases reuse it and which don't. Expand coverage into phases that still do per-session fetches. This replaces the v1 "add alias batching" framing: before adding new batching, prove the existing batching is fully reused.
3. **Persistent REST ETag cache** — disk-backed, bounded, keyed by `(transport, endpoint)` since Codex proved ETags are transport-specific. Only worth doing if traces show hot endpoints with high repeat rates.
4. **Any remaining hot-spot-specific reduction** the baseline uncovers. Deliberately open — we don't know what traces will say until we run them.

**Track B stop rule — scorecard, not single threshold.**

"Under 5000/hr core budget" is one row of a six-row scorecard. Track B is done when every row is green on every cell of the pruned scenario × topology × scale matrix:

| Metric | Green threshold | Why it matters |
|---|---|---|
| **REST core hourly headroom** | ≥40% at 50 sessions on every scenario | Primary PAT budget. 40% headroom absorbs bursty scenarios that the averaged view hides. |
| **GraphQL hourly headroom** | ≥40% at 50 sessions on every scenario | Separate point bucket. Not covered by REST headroom. |
| **Peak observed concurrency** | <50 in-flight subprocesses at any moment | Well below GitHub's documented ≈100 concurrent guideline and below whatever the local subprocess semaphore cap is set to. |
| **Max requests/sec (1s window)** | <30/sec at any moment | Burst-shape proximity to the secondary-limit cliff we couldn't empirically probe. |
| **Max requests/sec (10s window)** | <20/sec sustained | The sustained variant — catches backlogged bursts that the 1s window misses. |
| **Writes/minute during review bursts** | <200/min | Documented secondary limit is ≈900 pts/min for writes; 200 gives us 4× headroom on review-reaction bursts. |
| **Count of `403`/`429`/`Retry-After`** | Exactly zero across the full matrix | Any non-zero triggers immediate investigation, not a threshold. |

If every row is green and Track B has been closing the biggest remaining hot spot in each iteration, Track B is done. If the scorecard is green but a specific hot spot (say, `detectPR` fan-out at 50 same-repo sessions) is still obviously expensive in absolute terms, we land that optimization anyway — green scorecard is necessary but not sufficient to stop working.

---

### Track C — Optional: transport migration

Only if Track B is insufficient.

- Add `OctokitRunner` as a second `GhRunner` implementation behind a flag.
- Run the same scenario matrix against both transports and compare summaries.
- Migrate only if the numbers justify the risk (auth model changes, error shapes, losing `gh`'s ambient auth).

---

## Out of scope

- GitHub webhooks / event-driven lifecycle. Bigger rewrite; separate project.
- GitHub App migration. Auth change; separate project.
- UI/dashboard changes.
- Any change to SSE interval (`C-14`).

---

## Open questions

Reduced from v2. Most of the v2 open questions turned out to be implementation choices that don't need to block Phase A1 — they should be decided in the first patch and revisited only if they prove painful.

### Real blockers (need your call before Phase A1)

1. **Migration policy.** Hard cutover (all `gh` invocations in `scm-github` + `tracker-github` go through the wrapper in one PR) or plugin-by-plugin across multiple PRs? Lean: hard cutover for those two plugins in Phase A1 — they're the only hot paths and a partial migration splits the baseline. But if review bandwidth is a concern, splitting is acceptable as long as the baseline matrix waits for both plugins to land.
2. **Attribution granularity.** Free-form `source` string (`"scm-github.detectPR"`) or a closed enum? Lean: free-form — less friction to add new call sites, grep-friendly in summaries. Summary tool treats `source` as an opaque key. This matters now because it shapes the JSONL schema.

### Decide in the first patch (not blockers)

3. **Package location.** New `@aoagents/ao-gh-transport` package, or fold into `@aoagents/ao-core`? Lean: new package — keeps core lean, isolates harness tests. But this is a refactoring choice, not a design blocker. If the first patch shows `@aoagents/ao-core` is simpler for `scm-github` + `tracker-github` to consume cleanly, we go there and move it later.
4. **`cycleId` plumbing.** Track A's waste metrics (duplicate detection within a cycle) are cleanest when every call inside one lifecycle poll cycle shares a `cycleId`. The lifecycle manager would have to generate one and thread it through. **Not a blocker.** Phase A1 ships with `cycleId` as a nullable attribution field. If the first patch shows the threading is cheap, we populate it in Phase A1; if it's expensive, we ship Phase A1 without it and compute cycle membership heuristically from `(projectId, sessionId, phase, timestamp)` clustering — the summary tool can do this as a second pass. `cycleId` becomes a proper field in a follow-up patch.
5. **Token fingerprint in trace rows.** Nullable SHA-256 prefix of the active token (or authenticated `login`) so multi-token environments can be sliced correctly. Schema-reserved from day one, populated only when we actually need it.

### Already settled

6. **Tracing activation.** Settled by the counters/raw split (added in v2.1) plus the env-only deferral (added in v2.2, unchanged in v2.3). Counters mode and raw JSONL mode are both implemented in Phase A1, both default off. Raw JSONL is turned on explicitly for the Phase A2 matrix runs via **env var only in Phase A1** (`AO_GH_TRACE=1` or `AO_GH_TRACE_FILE=<path>`); config-file activation (`gh.trace: true` in `agent-orchestrator.yaml`) is deferred to a follow-up patch and intentionally not part of A1. Counters mode stays off in Phase A1 and we revisit enabling it after we trust the schema.

---

## Artifacts we will produce

Phase A1:
- `packages/gh-transport/` (new package) — `GhRunner` interface, `GhSubprocessRunner`, recorder, summary tool.
- Edits under `packages/plugins/scm-github/src/**` and `packages/plugins/tracker-github/src/**` replacing raw `gh` invocations with `runner.run(...)`. Zero behavior delta.

Phase A2:
- `experiments/baseline.md` — scenario × scale matrix with summary-tool output per cell.

Track B (per-fix):
- One PR each, with a short "before / after" trace summary in the description.

---

## What changed from v2.2 → v2.3

Reviewer #4 pushback. Five findings accepted, two of them with my own sharper framing:

- **Runner contract rewritten to preserve reject-on-nonzero.** v2.2 simultaneously said "wrapper preserves behavior, callers keep deciding when to throw" and "wrapper does not throw on `304`" — mutually exclusive under `execFileAsync`, which rejects on non-zero exit. v2.3 resolves this by making `run()` **reject** on non-zero exit/timeout with a `GhRunnerError` whose shape matches today's `execFileAsync` rejection in the fields current callers rely on (`name`, `.code`, `.stdout`, `.stderr`, `.message` prefix), **plus** an additional `.ghResult` field carrying the full parsed block. Existing `try/catch`/`.catch()` at every call site keeps working; recorders still capture parsed status/headers/etag on the failure path (notably the `304`-as-exit-1 case). This is stronger than the reviewer's binary "pick one" framing: keep today's semantics, attach the parsed data to the rejection.
- **`cacheDecision` removed from Track A entirely.** v2.2 defined `cacheDecision` as a caller-set field "written back into the trace row" — impossible against append-only JSONL without re-engineering the recorder. v2.3 cuts the field from `GhResult`, cuts `conditional_cache_hit_rate` from Track A metrics, and defers the caller-level metric to Phase B1 where the 304-handling fix naturally adds a cache decision at the call site. Track A now measures one ETag metric (`conditional_304_rate`, transport-level, computed from both resolved and rejected rows). This is stronger than the reviewer's "re-engineer the mechanism" position — the metric genuinely doesn't belong in A1.
- **Large-output golden test rewritten.** v2.2 required "no truncation in raw storage" for >1 MB output AND a 64 KB stdout cap in the redaction section — contradictory. v2.3 drops the no-truncation assertion and instead requires: no subprocess crash, parser populates `parsed` from early bytes, recorder applies the 64 KB cap, row records `stdoutTruncatedBytes` correctly, and output beyond an explicitly-configured `maxBuffer` (≈10 MB, set to dodge `execFileAsync`'s default 1 MB `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) produces a controlled rejection identical in shape to today's overflow error.
- **304 and auth golden tests rewritten around rejection.** Both tests now assert `run()` rejects with the expected `.code`, the rejected error's shape matches today's `execFileAsync` rejection, and `error.ghResult` carries the full parsed block (status, rateLimit, stderr) — instead of v2.2's "wrapper does not throw" which contradicted the reject-preserving contract.
- **Redaction header/body split made explicit.** The recorder splits raw stdout at the first blank line before redaction. Headers (including `x-ratelimit-*`, `etag`, `retry-after`) are preserved verbatim; only the body is subject to comment redaction or drop-on-failure. `redactionFailed: true` applies to the body only — headers are still written even when body redaction fails, because they carry the signals the harness exists to capture.
- **Stale "already decided" text aligned with v2.2 env-only decision.** The open-questions "tracing activation" entry used to say "env var or config field," contradicting v2.2's explicit deferral of `gh.trace: true` out of A1. Fixed to say env-only for A1.
- **Stale "open question #1" reference fixed.** Phase A1 text used to point at "open question #1" for package location; after v2.1 restructured the open questions, package location is now #3. Updated.

## What changed from v2.1 → v2.2

*Historical record. Some items below were later revised in v2.3 — superseding notes inline.*

Reviewer #3 pushback, all seven findings accepted:

- **Automated A1 acceptance bar added** alongside the code-review checklist. Golden tests on `GhSubprocessRunner` covering success, conditional `304` (exit 1 + `parsed.notModified`), timeout, large stdout/stderr, and non-zero exit with stderr. Plus one real smoke run verifying AO reaches the same lifecycle states with tracing off. The checklist is necessary; the automated bar catches what review misses (buffering, stdin wiring, timeout propagation, env merging, error-object shape).
- **ETag guard metric split** into `conditional_304_rate` (transport-level: did gh surface 304?) and `conditional_cache_hit_rate` (caller-level: did AO actually treat the result as unchanged?). Baseline divergence between the two is itself the evidence that Bugs #1 and #2 are live. Post-fix convergence is the evidence that they're dead. Required a new `cacheDecision: "hit" | "miss" | null` field on `GhResult` that the caller sets after processing. **Superseded in v2.3**: `cacheDecision` removed; `conditional_cache_hit_rate` deferred to Phase B1; Track A now measures only `conditional_304_rate`.
- **Track B stop rule replaced** with a 7-row scorecard: REST hourly headroom, GraphQL hourly headroom, peak observed concurrency, max req/sec over 1s and 10s windows, writes/minute during review bursts, and count of `403`/`429`/`Retry-After`. Each must be green on every cell of the matrix. "Under 5000/hr REST" was one row of seven.
- **Topology axis added to Phase A2 matrix.** Same-repo concentration vs multi-repo spread crossed with scenario and scale. `detectPR` fan-out and same-repo batch reuse are invisible on the spread topology; cold-start storms and review bursts might behave differently on each. Full matrix is ~54 cells; we run it once and prune to ~20–30 representative cells for `baseline.md`.
- **Privacy/redaction/retention section added** for raw JSONL mode. Stdout truncated at 64 KB per row, stderr in full, GraphQL query text logged (structural, not PII), comment bodies redacted via an explicit known-fields pass, repo/branch/title names preserved (load-bearing, low sensitivity), token fingerprint nullable and defensively scrubbed, 7-day retention for raw / 30-day for counters, local-only storage. Recorder enforces; row with a redaction failure drops the raw body and flags `redactionFailed: true` rather than writing unredacted content.
- **`gh.trace: true` config-file activation deferred out of Phase A1.** Env-only for A1 (`AO_GH_TRACE=1` / `AO_GH_TRACE_FILE=<path>`). Config schema is plumbing work that doesn't belong in a near-mechanical wrapper phase; we add it as a small follow-up if deliberate-run friction justifies it.
- **`source` attribution gets a naming rule.** Format: `<plugin>.<module>.<operation>`. Examples: `scm-github.batch.guard1`, `scm-github.detectPR.list`, `tracker-github.issue.get`. Still free-form underneath, but the convention keeps per-source cardinality from drifting into noise.

## What changed from v2 → v2.1

*Historical record. Some items below were later revised in v2.2/v2.3 — superseding notes inline.*

Reviewer #2 pushback, all accepted:

- **Tracing split into two modes.** Counters (light, in-memory, always-on-capable later) and raw JSONL (heavy, opt-in, matrix-run only). Both code paths ship in Phase A1; both default off. Raw JSONL is enabled via env var AND `gh.trace: true` in `agent-orchestrator.yaml` so deliberate runs don't depend on a shell flag. **Superseded in v2.2**: `gh.trace: true` config-file activation deferred out of Phase A1; env-only for A1.
- **Raw + normalized promoted to a stated design rule** — not just an accident of the `GhResult` type. New call sites MUST NOT drop raw fields when adding new parsers.
- **"Zero behavior delta" acceptance bar reworded** to "no intentional semantic change in success/failure decisions, cache behavior, or state transitions." Replaced the diff-observable-behavior acceptance test with an explicit 4-question code-review checklist applied to every migration patch. Tracing legitimately shifts timing, so a diff-based bar would chase flakes.
- **Open questions restructured.** Package location and `cycleId` plumbing demoted from blockers to implementation choices decided in the first patch. Real remaining blockers for Phase A1 kickoff are migration policy (hard cutover vs plugin-by-plugin) and attribution granularity (free-form `source` vs closed enum). Tracing activation is already answered by the counters/raw split.

## What changed from v1

For reviewers comparing against the previous draft:

- **Tracks split.** Baseline recorder (Track A) is strictly behavior-preserving. Fixes (Track B) only start after baseline is captured. This removes the v1 contradiction where Phase 1 both "records current behavior" and "handles 304 at the transport layer."
- **Abstraction flipped from request-shaped to command-shaped.** `GhRunner.run({ args, ... })` instead of `GhTransport.request({ method, endpoint, body, ... })`. Matches the actual mix of `gh api`, `gh pr view`, `gh pr checks`, `gh issue view`, `gh issue list`, `gh pr list` that AO uses today. No semantic rewrite in Phase A1.
- **Error-handling policy reversed.** v1 said "always return, never throw"; v2 preserves current throw/reject semantics so baseline reflects current behavior. Normalize later if needed.
- **Trace storage moved global.** `~/.agent-orchestrator/traces/gh-YYYY-MM-DD.jsonl` with `projectId`/`sessionId`/`phase`/`source`/`cycleId` inside each row. Rate limits are per-token, not per-project.
- **Tracing default flipped to opt-in** for Phase A1 via `AO_GH_TRACE`. Revisit after we have real numbers.
- **Baselines are now scenario × scale**, not scale-only. Cold start, quiet steady, spawn storm, review backlog burst, cache-miss, dashboard load × 1/5/10/25/50.
- **Waste metrics and concurrency metric added** — duplicates within a cycle, ignored-result candidates, cold-start storms, peak observed concurrency from overlapping intervals, burst shape.
- **Problem framing rewritten** around measured hot spots (broken guard, Guard 2 steady state, detectPR fan-out, review backlog bursts, cold-start) instead of the naive "12 per session per cycle" headline.
- **`detectPR` optimization sharpened** to repo-level collapse per poll cycle, not per-branch dedup.
- **GraphQL "alias batching"** reframed as "measure current batch reuse coverage, then expand gaps" — no assertion that batching isn't already in place.
- **Secondary limits** stay as documented-limit targets, but the harness now explicitly measures peak in-flight concurrency and burst shape so we know when we're close to the cliff.
