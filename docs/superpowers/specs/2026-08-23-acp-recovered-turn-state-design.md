# ACP Recovered Turn State

## Problem

ACP `session/load` replays persisted conversation events but does not report the
terminal outcome of the last native turn. Provider output proves only that some
work was persisted; it does not prove that the turn completed. The agent may
have persisted a partial response and then crashed.

The current generic ACP adapter must nevertheless emit a terminal replay event
so AO can import the transcript without leaving the final turn running. Mapping
that event to `completed`, `interrupted`, or `failed` invents an outcome that the
protocol did not provide.

## Shared lifecycle contract

Add `domain.TurnStateRecovered` with the wire value `recovered`. It means:

- AO recovered a terminal historical boundary from provider replay;
- no further work is expected for that historical turn; and
- the provider did not supply enough evidence to classify the outcome as
  completed, interrupted, or failed.

`recovered` is terminal. It is not a successful result, an error, or evidence of
user cancellation.

Expose the state through the existing conversation API enum and generated
frontend schema. The Chat timeline renders the outcome as `Recovered` with a
neutral tone. Existing clients that treat all non-running/non-queued states as
terminal retain their current behavior.

## ACP replay policy

The generic ACP history core applies one policy for every ACP provider:

- A reconstructed turn followed by a later user-message boundary is
  `completed`. The later accepted prompt is evidence that the preceding native
  turn was no longer active.
- The final unbounded replay turn is `recovered`, regardless of whether replay
  contains user-only content, assistant output, reasoning, or tool activity.
- No provider adapter may infer completion from the presence of output.

The obsolete `turnHasProvider` classification is removed because provider
output no longer changes the final-tail outcome.

## Reconciliation

`reconcileNativeHistory` remains above individual drivers and preserves AO's
stronger durable evidence:

- If a replay turn maps to an existing AO turn whose state is already terminal
  (`completed`, `interrupted`, `failed`, or `recovered`), retain the existing AO
  state.
- If the existing AO turn is `running` or `queued`, retain the replay's
  `recovered` state. A daemon restart or provider crash did not establish a more
  precise outcome.
- Imported/provider-only history with no AO match keeps `recovered`.

This makes reconciliation monotonic: weak replay evidence cannot overwrite a
known terminal result, while weak AO in-flight state cannot overwrite a
terminal recovered boundary.

## Storage and presentation

Settling a recovered turn writes `completed_at` like every other terminal turn.
Any still-running activities in that turn become `cancelled`, the existing
neutral stopped status, because marking them completed or failed would repeat
the same unsupported inference. Already-settled activity facts are unchanged.

The frontend adds `recovered` to `TurnState` and to the turn-outcome component.
It displays `Recovered` without destructive/error styling. No new interaction
or recovery action is introduced.

## Compatibility and generation

SQLite stores turn state as text and needs no migration. The API enum changes in
the code-first DTO source, followed by `npm run api` to regenerate both
`openapi.yaml` and `frontend/src/api/schema.ts`.

The change is additive on the wire. Older persisted states remain valid, and no
existing terminal state changes meaning.

## Verification

Tests cover:

1. `recovered` is terminal in the domain model.
2. ACP final tails with provider output and with only a user message both emit
   `recovered`; a bounded earlier turn remains `completed`.
3. Reconciliation preserves known completed/interrupted/failed AO outcomes.
4. Reconciliation converts an existing running AO turn and provider-only import
   to `recovered`.
5. Storage settles running activities neutrally for a recovered turn.
6. API generation has no drift and the frontend renders `Recovered`.
7. Focused race tests, backend build/test/vet/lint, frontend typecheck, and PR CI
   pass after the adapter is rebased onto current `main`.
