# Review state contract

This document defines the durable facts and derived states used by review UI.
It is a behavior contract and case catalog, not an implementation plan.

## Principles

- The daemon owns durable SCM observations, AO review runs, and delivery facts.
- The UI derives presentation state at read time. It does not persist labels such
  as “ready,” “blocked,” or “stale.”
- PR lifecycle, review progress, CI, mergeability, comments, and feedback
  delivery remain independent dimensions. A single badge must not erase the
  other facts.
- A session can own multiple PRs. Every derived record is keyed by canonical PR
  URL; PR number alone is not a stable join key across repositories.
- The current PR head SHA determines whether an AO review is current. A verdict
  against another SHA is historical, never approval of the current code.
- General PR comments and inline code comments are counted separately because
  only inline comments have a file-and-line navigation target.

## Authoritative facts

| Dimension | Source | Notes |
| --- | --- | --- |
| PR lifecycle and head | `SessionPRSummary` | `draft`, `open`, `merged`, or `closed`; includes current `headSha` |
| CI | `SessionPRSummary.ci` | `unknown`, `pending`, `passing`, or `failing` |
| Mergeability | `SessionPRSummary.mergeability` | `unknown`, `mergeable`, `conflicting`, `blocked`, or `unstable` |
| Provider reviews | `SessionPRSummary.review` | Latest decisive reviews and unresolved provider comments |
| AO review eligibility | `PRReviewState` | Pure backend planner result for the current head |
| AO review history | `ReviewRun[]` | One durable row per review pass |
| Injection policy/result | Current `ReviewRun` | Policy is snapshotted when the result is recorded; `deliveredAt` is durable |

Runtime activity and panel visibility are not review state. A failed or unknown
runtime probe is not proof that a review is dead.

## Derived dimensions

`derivePRReviewPresentation` exposes these dimensions:

- `lifecycle`: the durable PR lifecycle.
- `progress`: `ineligible`, `not_started`, `running`, `approved`,
  `changes_requested`, `review_required`, `stale`, `failed`, `cancelled`, or
  `unknown`.
- `attention`: the one primary action/status used by compact surfaces.
- `ci` and `mergeability`: unchanged normalized SCM states.
- `comments`: unresolved total, inline count, and general count.
- `cycleCount`: distinct trigger batches for the PR. Legacy runs without a
  batch use their run ID as one cycle.
- `currentSha` and `reviewedSha`: enough to identify a stale review without
  displaying a full commit hash by default.
- `injection`: `not_applicable`, `disabled`, `pending`, `delivered`, or `failed`.

## Primary-attention precedence

Compact UI chooses one primary attention state in this order while retaining
all other dimensions for detail:

1. Merged → `complete`
2. Closed → `closed`
3. Draft → `draft`
4. Current review running → `review_running`
5. AO/provider changes requested or unresolved human comments → `changes_requested`
6. Merge conflict or provider merge block → `merge_blocked`
7. CI failing → `ci_failing`
8. CI pending → `waiting_ci`
9. Approved, CI passing, and mergeable → `ready_to_merge`
10. Not started, required, stale, failed, or cancelled → `needs_review`
11. Incomplete/forward-compatible facts → `unknown`

This precedence answers “what needs attention now?” It does not claim, for
example, that a changes-requested PR has no CI failure.

## Canonical case catalog

| Case | Derived result | Compact UI behavior |
| --- | --- | --- |
| Session has no PR | No per-PR record | Show the Reviews settings and a no-PR empty state |
| Draft PR | `ineligible` / `draft` | Explain that review waits until the PR is ready |
| Open PR, no AO or provider review | `not_started` / `needs_review` | Offer Run review |
| Provider requires review | `review_required` / `needs_review` | Identify review requirement |
| AO review is running on current SHA | `running` / `review_running` | Show reviewer and cancellable progress |
| AO approves current SHA | `approved` | Combine with CI and mergeability for primary attention |
| AO requests changes on current SHA | `changes_requested` | Show findings before merge/CI details |
| Provider requests changes | `changes_requested` | Attribute the external reviewer |
| Provider approved, unresolved human comments remain | `changes_requested` | Unresolved actionable comments override approval |
| Bot comments remain unresolved | Preserve counts/source | Do not set the human-comment fact; still show the bot source in detail |
| Earlier SHA was approved | `stale` / `needs_review` | Mark earlier pass; never call current SHA approved |
| Earlier SHA requested changes | `stale` / `needs_review` | Retain history without applying its verdict to current code |
| Current AO run failed | `failed` / `needs_review` | Show failure and allow retry |
| Current AO run cancelled | `cancelled` / `needs_review` | Show cancellation and allow retry |
| Approved, merge conflict | `approved` / `merge_blocked` | Preserve approval; primary action is resolving conflicts |
| Approved, provider block | `approved` / `merge_blocked` | Show provider reasons |
| Approved, CI failing | `approved` / `ci_failing` | Preserve approval; primary action is fixing CI |
| Approved, CI pending | `approved` / `waiting_ci` | Preserve approval; wait for checks |
| Approved, CI passing, mergeable | `approved` / `ready_to_merge` | Present ready-to-merge state |
| Mergeability unstable/unknown | Preserve raw state | Do not claim ready; show uncertainty in detail |
| CI unknown | Preserve `unknown` | Do not treat unknown checks as passing |
| PR merged | `ineligible` / `complete` | Historical read-only review information |
| PR closed without merge | `ineligible` / `closed` | Historical read-only review information |
| Multiple PRs in one session | One record per canonical URL | Never aggregate verdicts into a false session-wide approval |
| Same PR number in different repos | Join by URL | Keep records independent |
| Duplicate provider observation | Same derived facts | UI remains idempotent |

## Comment cases

| Comment shape | Classification | Later navigation behavior |
| --- | --- | --- |
| File and positive line | Inline | Open current file and highlight the line |
| File without line | General/file-level | Open the file without a line highlight |
| URL without file | General | Keep the user in Reviews; offer provider link |
| Neither file nor URL | General/unaddressable | Show content and attribution without a broken action |
| Multiple comments on one line | Multiple inline findings | Group at one code location without dropping comments |
| Renamed file | Historical inline | Resolve current path when known; otherwise use provider permalink |
| Deleted file | Historical inline | Use historical diff/provider permalink |
| Comment targets older SHA | Stale inline | Label the revision before navigating |
| Resolved comment | Historical, not unresolved | Retain in its cycle; exclude from unresolved count |
| Comment from another PR in the session | Different PR record | Select that PR before opening its target |

The current API exposes file, line, URL, and injection policy for unresolved
comments. Historical SHA, diff side, rename metadata, and resolved comment
history require explicit contract additions before file navigation can promise
those fallbacks.

## Review cycles

A review cycle is one trigger batch scoped to a PR. All runs sharing a non-empty
`batchId` count as one cycle; a legacy run with no batch counts by its run ID.
This prevents a multi-reviewer batch from inflating the displayed cycle count.

- Re-running after requested changes creates a new cycle, even on the same SHA.
- A new commit does not itself create a cycle; the next review trigger does.
- Failed and cancelled attempts count because the user initiated a real cycle.
- Provider-only reviews are not AO cycles. They remain external review events.
- Cycle order comes from run creation time, not commit lexical order.

## Auto-review cases

| Condition | Expected behavior |
| --- | --- |
| Disabled | Never trigger automatically |
| Enabled, no eligible open PR | Wait without creating a run |
| Enabled, worker active | Wait for the configured idle threshold |
| Enabled, worker idle, current SHA unreviewed | Trigger one batch |
| Current SHA already running | Do not trigger another batch |
| Current SHA approved | Do not trigger again |
| Current SHA has changes requested | A later explicit/eligible cycle may run according to coordinator rules |
| New SHA after completed review | Current state becomes stale/needs review; eligible for a new cycle |
| Reviewer unavailable or unauthorized | Record/surface failure; do not pretend a review ran |
| Draft, merged, or closed PR | Ineligible |
| Multiple eligible PRs | One trigger batch may contain one run per PR |

## Feedback injection cases

| Facts | Derived injection state | Meaning |
| --- | --- | --- |
| No terminal current run | `not_applicable` | Nothing is ready to inject |
| Snapshotted policy disabled | `disabled` | Result remains visible but is not sent to the worker |
| Terminal result, enabled, no delivery timestamp | `pending` | Delivery has not been durably confirmed |
| Status delivered or `deliveredAt` present | `delivered` | Feedback was sent once |
| Review run failed | `failed` | No successful result is available to deliver |
| Review cancelled | `not_applicable` | Cancellation is not feedback |

Later delivery UI must also distinguish duplicate suppression, superseded
feedback, worker unavailable, and retry outcomes. Those facts are not currently
represented by `ReviewRun`; they require a backend contract change rather than
frontend inference.

## Explicit non-goals

- No visual redesign is defined here.
- No summary prose is generated here.
- No provider URL parsing is used to invent missing file metadata.
- No display status is written back to SQLite.
- No cross-PR “overall approved” state is produced.
