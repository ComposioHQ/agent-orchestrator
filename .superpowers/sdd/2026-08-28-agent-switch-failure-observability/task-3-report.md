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
