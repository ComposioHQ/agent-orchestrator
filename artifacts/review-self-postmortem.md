# Self-postmortem: Why I missed illegalcall's review findings

This document is an honest accounting of why I did not catch the seven issues
illegalcall raised on PR #1478 during the work I did on this branch. The goal
is not to list the issues again — it is to identify the recurring failure
patterns in my review and design process so I can avoid them next time.

---

## Scope of what I touched vs. what I reviewed

The branch contained two independent change clusters:

1. The TTL cache + in-flight dedup in `session-manager.ts` and the duplicate
   in `agent-opencode/src/index.ts` — pre-existing in commit `9cbf7280`,
   authored by miniMaddy.
2. The cross-platform janitor + process-level wiring — my own work in commit
   `5de970a4`.

When the user asked me to "do a quick review of your changes if it makes
sense," I limited my review to **the diff I had just produced**. I did not
re-read the surrounding code I had inherited. Five of the seven findings live
in code I did not write but did review by proxy when I greenlit the branch
state. Two findings (#3, #4, #5, #7) live in code I directly modified.

---

## Issue-by-issue: what I missed and why

### #1 — TTL kills the timestamp delivery signal in `sendWithConfirmation`

**What I missed.** The 3-second TTL exactly straddles the send-confirmation
loop window (6 attempts × 500 ms = 3 s). Every `getOpenCodeSessionUpdatedAt()`
call inside the loop returns the same cached snapshot, so the
`updatedAt > baselineUpdatedAt` branch can never fire. The author's comment
in `session-manager.ts` even says the TTL was sized to *cover* the loop —
which I read as a feature. illegalcall correctly read it as a bug: covering
the loop with the TTL means the timestamp signal is dead by construction.

**Why I missed it.** I read the author's intent comment and trusted it. I
did not trace the code path from `sendWithConfirmation` back through
`getOpenCodeSessionUpdatedAt` → `fetchOpenCodeSessionList` to verify the
claim. When a code comment asserts a design property, I should treat it as a
hypothesis to verify, not a fact to accept.

**Pattern:** *I confused author intent with author correctness.*

---

### #2 — `deleteOpenCodeSession()` does not invalidate the cache

**What I missed.** The cache is a write-back layer over an external system
(opencode). Like every cache, it must be invalidated on writes. The PR
caches reads but ignores writes. I never opened `deleteOpenCodeSession`
during my review because the diff did not touch it.

**Why I missed it.** I limited my review to the lines in the diff. A cache
introduction is a system-wide change: every mutating code path becomes a
potential staleness source, even paths the diff does not modify. I should
have searched for every call site that mutates opencode session state and
audited them as part of reviewing the cache, not as part of reviewing the
diff.

**Pattern:** *I reviewed line-level changes when the change was system-level.*

---

### #3 — Janitor sweeps all of `/tmp`, not just AO's children

**What I missed.** The regex matches any Bun-extracted shared library on
the host. I focused on cross-platform correctness (so/dylib, Linux/macOS) and
treated the regex itself as a given. I never asked the more important
question: *what else does this regex match that I do not own?*

**Why I missed it.** I framed the cross-platform task as "make the existing
behavior work on macOS." I optimized for parity with the Linux behavior
rather than questioning whether the Linux behavior was correct in the first
place. The right framing was: "this janitor deletes files; what is the
smallest blast radius that solves the actual problem?"

The cleaner solution illegalcall proposes (set `TMPDIR` for opencode children
to an AO-owned subdir, sweep only that path) makes the regex defensive logic
unnecessary entirely. I should have proposed it because it is *less* code,
not more.

**Pattern:** *I extended an existing design instead of questioning whether
the design was right.*

---

### #4 — `Promise.all` over all `/tmp` entries before the regex filter

**What I missed.** A straightforward perf bug visible in the code structure.
On a host with thousands of files in `/tmp`, the janitor allocates one
promise per file before filtering. The fix is one line of reordering.

**Why I missed it.** I read the function for correctness, not cost. I did
not consider the worst-case input size for `readdir(tmpdir())`. CI runners
and long-running boxes routinely have tens of thousands of entries in their
temp directory.

**Pattern:** *I reviewed for correctness without considering input-size
sensitivity.*

---

### #5 — `stopBunTmpJanitor()` does not await in-flight sweep

**What I missed.** A classic async cleanup bug. Clearing the interval
prevents future ticks but does nothing about the tick that is currently
running. On SIGTERM the process can exit while `unlink` calls are in flight.

**Why I missed it.** I noted in my own review that the timer is `unref`'d
and "dies with the process," and I conflated "the timer dies" with "all work
the timer started dies." The interval handle is unref'd; the in-flight
`Promise` chain is not. Different lifetime, different cleanup story. I
should have separately accounted for both.

**Pattern:** *I conflated the lifecycle of a timer with the lifecycle of the
work a timer schedules.*

---

### #6 — Two independent caches in core and the plugin

**What I missed.** Two `let cache: Cache | null = null` module-level
variables, two `resetOpenCodeSessionListCache()` exports, two cache shapes
that look identical. They share zero state. Per poll cycle the system
spawns at least 2 `opencode session list` processes (one per cache) instead
of 1.

**Why I missed it.** I noted in my first analysis that the plugin had its
own cache and called it "intentional (different call path)" because that is
what the greptile summary said. I copied the framing. The framing is wrong
— the call paths are sequential within the same poll cycle, not independent
clients. The "different call path" justification only holds if the call
paths are isolated. They are not.

**Pattern:** *I accepted a justification from another reviewer without
running the trace myself.*

---

### #7 — Silent successful sweeps in `start.ts`

**What I missed.** I deliberately reduced the `onSweep` callback to "log
on errors only." I called this "cleanliness" — no log spam from a 60-second
heartbeat that usually does nothing. illegalcall is right that this leaves
operators blind to whether the janitor is doing useful work.

**Why I missed it.** I optimized for log noise without asking what
information the operator needs. The correct framing: silent success is
acceptable for a heartbeat that has nothing to do, but **a sweep that
reclaims disk is not a heartbeat — it is the janitor doing its job**, and
operators want confirmation it happened. The two cases need different
treatment.

**Pattern:** *I reduced verbosity without distinguishing meaningful events
from heartbeats.*

---

## Cross-cutting failure patterns

Looking across the seven issues, three patterns appear repeatedly:

### A. Diff-bounded review for system-level changes

Issues #1, #2, and #6 all share the same root cause: I reviewed the changed
lines, not the changed system. A new cache is a system-level change. Every
read site, every write site, every test that relies on the underlying
behavior, is now in scope — whether the diff touches it or not.

**Correction:** When reviewing a change that introduces shared mutable
state (cache, lock, registry, in-process queue, etc.), open every call site
that *reads* and every call site that *mutates* the underlying resource.
Verify each one is consistent with the new state model.

### B. Trusting author/reviewer intent over independent verification

Issues #1 and #6 both came from accepting a stated rationale (an inline
comment, a greptile summary) without running the trace myself. The
rationales were not just imperfect — they were inverted from reality. The
TTL was sized to *cover* the send loop, which the author thought was a
feature; covering the loop kills the signal. Greptile said the two caches
were "intentional"; in fact they double the spawns the cache was meant to
prevent.

**Correction:** Treat all stated rationales as hypotheses. Verify with
code, not with comments.

### C. Optimizing within an inherited frame instead of questioning the frame

Issues #3 and #7 both came from accepting the existing design's framing.
The Linux-only janitor was framed as "this is the leak we have, this is
what we do about it"; I extended it cross-platform without asking whether
the leak should be contained at the source (per-process `TMPDIR`) instead
of swept globally. The error-only logging was framed as "less noise is
better"; I extended it without asking what an operator needs to see.

**Correction:** When the user asks for an extension, do a 30-second sanity
check on the design being extended. If a smaller, simpler, less invasive
solution exists, propose it before writing the extension.

---

## What I will do differently next time

1. **For any change introducing shared mutable state**, list every reader
   and every mutator of the underlying resource and audit each one against
   the new model. Do not stop at the diff boundary.
2. **Distrust inline rationales and reviewer summaries** for the
   correctness of subtle code (caches, locks, async cleanup). Re-derive
   the property from the code itself. If the comment is wrong, the bug is
   probably right next to it.
3. **Always ask "what is the smallest blast radius?"** before extending an
   existing solution. Containment beats cleanup; isolation beats defensive
   regex; per-resource scoping beats global sweeps.
4. **Account for the lifetime of work separately from the lifetime of the
   scheduler that started it.** Timer cleanup ≠ work cleanup.
5. **Distinguish heartbeats from meaningful events in logging.** A
   heartbeat that produced no work can be silent; a heartbeat that
   *reclaimed disk* is no longer a heartbeat.
6. **Always consider input-size sensitivity for code that reads a directory,
   walks a tree, or scans a list of unknown size.** What is the 99th
   percentile? Does the code fall apart on a CI runner with a stuffed
   `/tmp`?

---

## Confidence calibration

Of the seven findings, I rate my likelihood of catching each in a careful
re-review:

| # | Issue | Would I catch on careful re-review? |
|---|-------|------------------------------------:|
| 1 | TTL kills timestamp signal | Maybe — required tracing the send loop |
| 2 | Cache not invalidated on delete | Yes — searching for mutators is mechanical |
| 3 | /tmp blast radius | No — required questioning the design frame |
| 4 | Promise.all before filter | Yes — visible in the code |
| 5 | In-flight sweep on stop | Maybe — my mental model of `unref` was wrong |
| 6 | Duplicate caches | Yes — once I distrusted the "intentional" framing |
| 7 | Silent successful sweeps | No — required questioning the design frame |

Two out of seven (#3, #7) required questioning the design itself, not the
code. Those are the hardest to catch because they require stepping outside
the task framing. The other five are mechanical issues that a stricter
review checklist would catch.
