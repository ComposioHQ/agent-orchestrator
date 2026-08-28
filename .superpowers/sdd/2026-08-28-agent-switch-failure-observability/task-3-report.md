# Task 3 implementation report

Base: `c075d9cea`

## Files

- `backend/internal/domain/agent_switch_observability.go`
  - Defines the complete approved failure-point taxonomy and copied, sorted enumeration.
  - Defines exact reporting authorization and enrollment status contracts.
  - Defines closed enum-only fault, stack-frame, canonical-event input, and immutable-delivery event shapes.
  - Validates every enum, taxonomy callsite, report/phase/code applicability, switch/daemon scope, frame privacy, the 16 KiB stack bound, and the 60 KiB canonical JSON bound.
  - Builds fixed-order, struct-only JSON with UTC RFC3339Nano time, synthetic exception text, fixed tags/context, and no raw-error input.
  - Defines stable local dedupe components, issue fingerprints, EventID derivation, and sanitized-stack fingerprints.
  - Keeps `AgentSwitchFailureProductionEnabled` false.
- `backend/internal/domain/agent_switch_observability_test.go`
  - Exhaustively lists every approved failure point and checks taxonomy completeness, local-only sentinels, copied slices, exact closed struct shapes, enum rejection, applicability, frame privacy, size bounds, canonical bytes, deny-by-default privacy, and stable dedupe/fingerprints.
  - Tests were authored before production code but deliberately not executed under the user-requested consolidated-verification ruling.
- `backend/internal/ports/agent_switch_observability.go`
  - Defines provider-neutral delivery outcomes, safe error classes, throttle scopes, synchronous observer result, observer interface, and reporting-policy snapshot interface.
  - Contains no Sentry/provider dependency.
- `test/fixtures/agent-switch-observability/envelope-v1.json`
  - Freezes canonical event v1 bytes for the Task 5 deterministic envelope wrapper.
  - Contains no switch/session/project/workspace IDs, local paths, prompts/conversation content, runtime handles, idempotency data, or URLs.

## Contracts preserved for later tasks

- `AllAgentSwitchFailurePoints()` returns a fresh sorted slice.
- `outbox_delivery` and `classification_unknown` are explicit `local_only` taxonomy entries and cannot be serialized remotely.
- `AgentSwitchReportingAuthorization` fields are exactly `Enabled`, `ConsentGeneration`, and `DestinationFingerprint`.
- Enrollment statuses are exactly `enrolled`, `disabled`, `stale_generation`, `deduped`, and `local_invariant_failed`.
- Canonical event JSON uses only fixed structs; no tag/context map is marshaled.
- Event IDs are exactly 32 lowercase hexadecimal characters; time is normalized to UTC RFC3339Nano.
- Exception values are synthetic: `agent switch failure: <code> at <failure_point>`.
- Raw errors are structurally impossible to pass to the fault/event builder.
- Provider-neutral observer and delivery types live only in `internal/ports`; domain, ports, storage, and Session Manager have no Sentry import.
- Production reporting remains disabled.

## Static inspection performed

- Confirmed the worktree is isolated on `codex/agent-switch-failure-observability` at `c075d9cea` before edits.
- Compared failure-point string constants against the approved taxonomy section with a sorted `comm`; no missing or extra values were reported.
- Counted every point through declaration, canonical list, and taxonomy assignment; each occurs in all three surfaces.
- Ran `gofmt` on the new Go sources and tests.
- Parsed the frozen fixture with `jq -e`.
- Searched the fixture for prohibited local identifiers/content; no matches were found.
- Searched domain/ports sources for Sentry imports; none exist.
- Ran staged `git diff --check` before commit.

## Deferred verification

Per the explicit implementation-first ruling, no tests, builds, typechecks, compilers, or vet commands were run. Consolidated verification should execute at Task 12, beginning with:

```bash
cd backend && go test ./internal/domain -run 'AgentSwitchFailure|CanonicalAgentSwitch|AgentSwitchDedupe' -count=1
cd backend && go test ./internal/domain ./internal/ports -count=1
```

Then include these packages in the final full backend test, race, and vet suites.

## Fix round 1

Review corrections applied after commit `55fd9fe96`:

- Replaced the custom `title` and flat exception object with Sentry-recognized `message` and `exception.values`, and changed stack frames to the accepted `module`, `function`, `filename`, `lineno`, and `in_app` keys. The canonical event remains fixed-struct-only and deterministic.
- Changed `AgentSwitchDedupeKey` to require a validated `AgentSwitchDedupeScope`. Switch incidents now include the opaque switch ID, maintenance includes both switch ID and daemon-run ID, and daemon lifecycle uses only daemon-run ID, matching the approved formulas. Scope IDs remain local and never enter canonical JSON.
- Tightened report-kind applicability: terminal failures reject retained markers; semantic reports require `fault_code=not_applicable`; panic and daemon lifecycle require `error_code=not_applicable`; recovery-attempt and maintenance reports accept a durable semantic code only where the durable phase makes it real.
- Suppressed `stale` alongside `ok` and `expected_rejection`; required resolved target-start/runtime/tri-state facts for target-scoped points; required source-stop/gate facts for source-scoped points; and forced daemon/visibility switch-only fields to explicit `not_applicable`.
- Made stack requirements taxonomy-priority-based: panics and P0/P1 internal taxonomy entries require frames, while P2 entries may intentionally omit them.
- Added the provider-neutral `DeliveryResponseLost` error class for dispatcher response-loss settlement.
- Expanded deny-by-default tests across every free metadata and frame string, rejecting identifier-, absolute-path-, URL-, prompt-, and UUID-like values.
- Updated the frozen fixture and structural assertions to the accepted Sentry event shape.

Fix-round static inspection:

- `gofmt` completed for all changed Go files.
- `git diff --check` reported no whitespace errors.
- `jq` validated both fixture syntax and the exact recognized Sentry message/exception/frame keys.
- Approved taxonomy parity remained exact at 71 points with no `comm` difference.
- Fixture prohibited-content search and domain/ports Sentry-import search returned no matches.
- Runtime/compiler verification remains deferred under the same explicit no-test/no-build instruction.

## Fix round 2

Review corrections applied after commit `b5aaedf34`:

- Unified frame requirements with the exact full-tuple `severityForFault` used by canonical event emission. Ownership ambiguity and owner-commit contradictions now require frames even at warning-default points, while proven safe missing-binary, unauthorized-target, pre-stop abort, rollback, and visibility cases remain stackless warnings. Panics still always require frames.
- Restricted `recovery_attempt_failed` to one of the three unresolved retained markers at its exact durable phase. Added a semantic error/phase matrix that rejects impossible terminal classifications such as `delivery_unconfirmed` at `stopping_source`; recovery dedupe continues to include the unchanged current marker.
- Replaced permissive function text with documented normalized dot-separated Go symbols. Raw receiver syntax, generic receiver syntax, parentheses, arguments, locals, and provider text cannot enter frames.
- Replaced metadata token/denylist checks with exported closed environment, channel, platform, OS, and elapsed-bucket types. Platform is exactly `daemon|renderer`; preview feed names normalize to `preview`; release accepts only a bounded SemVer/build-release grammar.
- Replaced free stack-string denylist filtering with strict package/function/repository-relative source-file grammars, and expanded negative tests across every metadata and frame string category, including artifact hashes, issue-like values, paths, URLs, UUIDs, and argument renderings.
- Updated the golden fixture to the closed `stable` release environment. Local switch, daemon-run, and execution-attempt scope IDs remain excluded from canonical bytes.

Fix-round-2 static inspection:

- `gofmt` completed for the changed Go source and tests.
- `git diff --check` reported no whitespace errors.
- Fixture JSON shape/privacy, the 71-point taxonomy parity, production-disable constant, provider-neutral ports, and absence of Sentry imports were re-inspected without invoking a compiler.
- Runtime/compiler verification remains deferred under the explicit consolidated-verification instruction.

## Fix round 3

- Replaced the release-token pattern with bounded strict SemVer 2.0 validation: no `v` prefix; no leading zeroes in core or numeric prerelease identifiers; nonempty dot-separated prerelease/build identifiers; and the exact ASCII alphanumeric/hyphen identifier alphabet. Hyphenated prerelease and build identifiers remain valid.
- Added focused positive and negative cases for core versions, numeric prerelease zero rules, empty identifiers, invalid characters, the 96-byte boundary, `1.2.3-alpha-beta`, and `1.2.3+build-7`.
- The frozen fixture remains unchanged because its `1.2.3` release is valid strict SemVer and canonical field ordering is unaffected.
- `gofmt` and static diff inspection were repeated; runtime/compiler verification remains deferred as instructed.
