# PR #3550 cross-platform remediation and validation

Status: active; Slices 1-2 complete; configuration remediation, exact-head
validation, and maintainer re-review pending

Date: 2026-08-10

## Goal

Address the confirmed non-Linux test regression in upstream PR #3550 without
weakening its Linux-only `systemd` runtime contract. Make the configuration
boundary deterministically testable for Linux, macOS, and Windows; add the
missing native-platform CI coverage; then revalidate the complete containment
change on one exact current head.

## Observed inputs

The following GitHub objects were read authoritatively on 2026-08-10. Re-read
them before any rebase, push, review, or response because all are movable.

| Input | Observed value | Role |
| --- | --- | --- |
| Upstream PR | [Untrivial-ai/agent-orchestrator#3550](https://github.com/Untrivial-ai/agent-orchestrator/pull/3550) | existing delivery surface |
| PR head | `bd7baa54e829c3426cdeefe345b8252d1c8ed746` | pre-remediation rollback and lease point |
| PR base snapshot | `5f3e6bcd5a47bb7312f80cfc3966464a8f948cda` | original comparison base |
| Current upstream `main` | `c17b6c3f5a76dbbff38a05589ff6f9ac6c22ea54` | required rebase target at read time |
| Current fork `main` | `17748630b701367bc70edfab6155c272eb10595b` | fork validation reference only |
| PR state | open, ready, conflicting, review required | blocks delivery until refreshed |
| GitHub checks | none reported on the upstream PR head | requires exact-head fork validation |
| Formal reviews / review threads | `0 / 0` | not equivalent to a clean independent review |
| Actionable top-level feedback | [non-Linux `TestLoadOverrides` failure](https://github.com/Untrivial-ai/agent-orchestrator/pull/3550#issuecomment-5226399480) | remediation contract |

The report is valid: `TestLoadOverrides` sets
`AO_PROCESS_CONTAINMENT=systemd` on every host, while `Load()` correctly rejects
that value when `runtime.GOOS != "linux"`. The test therefore fails on macOS
and Windows before it reaches its assertions. The production validation is not
the defect and must remain strict.

## Ownership and execution boundary

Use one writer and one isolated worktree for the existing PR branch. Slice 1
found no AO owner or existing target-branch worktree and established a new
isolated worktree at the exact PR head as the sole writer. Older containment
worktree state is unrelated, preserved, and must not be reused or cleaned as
part of this task.

Before every mutation, re-read the PR head and stop if it no longer equals the
writer's expected head. Do not patch, stage, commit, push, or resolve feedback
from another worktree. A rejected lease, new owner, new review, or changed
remote head is a stop-and-reconcile event rather than permission to overwrite.

## Non-goals

- Do not make `systemd` containment available on macOS or Windows.
- Do not replace the explicit non-Linux configuration error with silent
  fallback.
- Do not redesign containment, tmux lifecycle, daemon wiring, or cleanup.
- Do not absorb unrelated upstream-main changes while resolving the rebase.
- Do not treat compilation, React Doctor, or green CI as the required
  independent current-head code review.
- Do not install, restart, reconfigure, or otherwise modify the production AO
  binary, service, database, Dashboard, or environment.

## Affected contracts

| Surface | Owner | Required outcome |
| --- | --- | --- |
| Configuration parsing | `backend/internal/config/config.go` | unset remains portable; `systemd` is accepted only for Linux; invalid values stay explicit |
| Configuration tests | `backend/internal/config/config_test.go` | generic override coverage is host-neutral; OS policy is covered deterministically |
| Native CI | `.github/workflows/cli-e2e.yml` | the config package runs on Ubuntu, macOS, and Windows |
| Runtime selection and tmux containment | runtime and tmux packages | no behavioral change beyond conflict reconciliation |
| Linux containment canary | tagged tmux integration test | `setsid`, ignored `TERM`, restart, destroy, and negative-control contracts still pass |
| PR delivery | GitHub exact head | required checks, separate review, and actionable feedback all refer to the same commit |

## Execution graph

### Slice 1: authoritative readback and single-writer confirmation

1. Read AO health before owner lookup.
2. Read the registered project catalog, complete session inventory, PR
   associations, and target-branch worktree associations.
3. Read GitHub PR metadata, fork branch head, upstream `main`, comments,
   reviews, and review threads.
4. Confirm that the PR branch is not checked out by another local worktree and
   that no matching host process is an active writer.
5. Establish one isolated worktree at the exact PR head; preserve all unrelated
   and dirty worktrees.

Acceptance:

- PR and fork branch both resolve to
  `bd7baa54e829c3426cdeefe345b8252d1c8ed746`;
- no AO session or PR association owns #3550;
- no pre-existing worktree or active process owns the target branch;
- one isolated worktree is designated as the sole writer; and
- no source, remote, PR, or production state is changed by the readback.

Status: complete on 2026-08-10.

### Slice 2: refresh and rebase the PR branch

1. Re-read the upstream PR head, fork branch head, and upstream `main`.
2. Fetch those exact objects and require the remote head still to equal the
   recorded lease point.
3. Rebase the PR branch onto the freshly read upstream `main`.
4. Resolve only conflicts required to preserve the existing containment
   contract and the current upstream implementation.
5. Inspect the complete rebased range before changing behavior.

Acceptance:

- the rebased branch contains the latest accepted upstream `main` as an
  ancestor;
- the containment diff remains scoped to the existing PR contract;
- no unrelated fork-only change is introduced; and
- the old exact head remains recoverable as the recorded rollback point.

Status: complete on 2026-08-10. The branch is locally rebased onto
`c17b6c3f5a76dbbff38a05589ff6f9ac6c22ea54`. Range comparison against the
original PR commit found only the upstream-required `errors` import in the tmux
integration test and the containment ADR renumber from `0002` to `0003`, because
upstream now owns ADR 0002. The rebased containment commit is
`8d52b7aa8cc8b08d9d5898efdf50411450929e76`; the fork branch remains at the
recorded pre-remediation head and has not been pushed.

### Slice 3: make configuration policy deterministic

Extract the environment-value and target-OS decision into a small unexported
pure helper, for example `parseProcessContainment(raw, goos)`. `Load()` passes
`runtime.GOOS`; tests pass explicit OS values.

Keep these invariants:

- empty input selects no containment on every OS;
- `systemd` succeeds only when `goos == "linux"`;
- `systemd` returns the existing Linux-only class of error for Darwin and
  Windows;
- unknown non-empty values remain invalid on every OS; and
- `Load()` remains the environment wiring boundary.

Remove `AO_PROCESS_CONTAINMENT=systemd` from the generic
`TestLoadOverrides`. Add focused table tests for empty, Linux, Darwin, Windows,
case/whitespace normalization, and invalid values. Keep one Linux-host wiring
test if needed to prove `Load()` passes the environment value through the pure
policy boundary.

Acceptance:

- tests describe policy independently of the runner OS;
- production behavior is unchanged; and
- the collaborator's reproduced macOS/Windows failure is no longer possible.

### Slice 4: add native-platform config coverage

Reuse the existing Ubuntu/macOS/Windows native matrix in
`.github/workflows/cli-e2e.yml`. Add a focused step:

```yaml
- name: Config unit tests
  run: go test -count=1 ./internal/config
```

Do not create a second platform matrix unless the existing job cannot provide
the required signal. The native runners, not cross-compilation from Linux, are
the authority for host-specific execution.

Acceptance:

- the config package executes on all three GitHub-hosted OS families;
- the workflow still runs for `backend/**` and workflow changes; and
- a future unconditional Linux-only override fails the macOS and Windows jobs.

### Slice 5: local verification

Run focused checks first, then the backend gate represented by the PR:

```bash
cd backend
gofmt -w internal/config/config.go internal/config/config_test.go
go test -count=1 ./internal/config
go test ./internal/adapters/runtime/runtimeselect ./internal/adapters/runtime/tmux
go build -p 2 ./...
go vet -p 2 ./...
go test -race -p 2 ./...
```

Also run `git diff --check` and inspect the full upstream-main-to-head diff.
If repository-owned commands have changed on the rebased head, use the current
commands and record the substitution.

Acceptance:

- focused configuration and containment tests pass;
- build, vet, and race tests pass on the rebased source; and
- no formatting, whitespace, generated-artifact, or unrelated-diff drift is
  present.

### Slice 6: Linux containment canary

Run the opt-in integration canary on a compatible Linux user-systemd host:

```bash
cd backend
AO_TEST_SYSTEMD_CONTAINMENT=1 go test ./internal/adapters/runtime/tmux \
  -run TestRuntimeIntegrationSystemdContainment -count=1 -v
```

Require evidence for:

- a descendant that calls `setsid` remains inside the worker scope;
- a descendant that ignores `TERM` is removed through the bounded kill path;
- restart creates the expected new handle and preserves command/input behavior;
- destroy leaves the worker scope inactive, dead, or not found;
- an outside-scope negative-control process survives worker teardown; and
- the canary cleans up only its disposable resources.

The canary is source validation, not production deployment.

### Slice 7: exact-head GitHub validation and review

Push the existing PR branch only with a lease tied to the last authoritative
remote head. If the upstream PR does not run contributor checks, create one
temporary draft PR in the fork whose head is exactly the upstream PR head and
whose base is pinned to the same upstream-main object.

Require the relevant Actions to pass on that exact head, including the native
config matrix, Go build/test/race, lint, API drift, CLI E2E, container smoke,
and secret scanning when triggered.

Then perform a code review that is explicitly separate from CI and automated
diagnostics. Review the exact current head across:

- configuration semantics and error compatibility;
- runtime selection and daemon wiring;
- systemd command construction and scope identity;
- create, restart, destroy, and failure cleanup;
- test determinism and platform assumptions; and
- workflow path filters and matrix behavior.

Acceptance:

- all required checks refer to the exact current PR head;
- the independent review records its range, head, and conclusion;
- unresolved actionable review threads equal zero; and
- the collaborator's top-level blocker has a concise evidence-backed response
  and a re-review request.

### Slice 8: handoff and cleanup

Do not equate a clean contributor branch with upstream merge authority. Leave
the upstream PR ready for maintainer review unless the platform and explicit
authority permit a later merge action.

After the fork validation PR is no longer needed, close it and remove only its
temporary validation branch. Preserve the upstream contribution branch and
the recorded pre-remediation head until maintainer disposition is final.

## Stop conditions and rollback

Stop without overwriting state if:

- the remote PR head changes unexpectedly;
- another AO or non-AO writer appears;
- the lease-protected push is rejected;
- the rebase requires behavior outside the existing containment contract;
- macOS or Windows still fails the config package;
- Linux containment or its negative control fails;
- current-head review finds an unresolved compatibility or lifecycle defect;
  or
- any step would touch production state.

The pre-remediation rollback point is
`bd7baa54e829c3426cdeefe345b8252d1c8ed746`. Reconciliation must preserve that
object and use lease-protected remote updates; never recover by deleting dirty
worktrees or force-updating an unexpected remote head.

## Final evidence

Completion requires one exact head with all of:

1. deterministic config policy tests;
2. Ubuntu, macOS, and Windows config-package runs;
3. focused containment tests and full backend gates;
4. the Linux systemd containment canary and surviving negative control;
5. an independent exact-current-head code review;
6. zero unresolved actionable review threads;
7. an evidence-backed response to the collaborator; and
8. an explicit statement that production AO remained unchanged.
