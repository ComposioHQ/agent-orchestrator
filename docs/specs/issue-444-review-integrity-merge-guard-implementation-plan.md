# Issue #444 — Review Integrity + Merge Guard (Implementation Plan)

This document is the implementation companion for GitHub issue #444:
"SPEC: Built-in Review Integrity + Merge Guard (Single-Shot Delivery)".

## Objective

Ship default-on review integrity and hard merge guard behavior for AO-managed PRs, with an auditable resolution workflow and explicit merge blockers.

## Scope (Single-Shot)

- Add review integrity domain contracts and evaluation engine in `@composio/ao-core`.
- Extend GitHub SCM plugin to fetch review thread snapshots and publish required check-runs.
- Add web APIs for propose -> verify -> apply resolution workflow.
- Enforce merge guard in `POST /api/prs/[id]/merge` with machine-readable blockers.
- Surface integrity/guard status in dashboard PR/session views.

## Domain Model

### ReviewThreadSnapshot

- `prNumber: number`
- `threadId: string`
- `source: "human" | "bugbot" | "other"`
- `path?: string`
- `bodyHash: string`
- `severity: "high" | "medium" | "low" | "unknown"`
- `status: "open" | "resolved"`
- `capturedAt: Date`

### ResolutionRecord

- `prNumber: number`
- `threadId: string`
- `resolutionType: "fixed" | "already_fixed" | "not_actionable" | "duplicate"`
- `actorType: "agent" | "human"`
- `actorId: string`
- `fixCommitSha?: string`
- `evidence: { changedFiles: string[]; testCommands: string[]; testResults: string[] }`
- `rationale?: string`
- `verificationStatus: "pending" | "pass" | "fail"`
- `createdAt: Date`

## Policy Rules

- `fixed` requires reachable `fixCommitSha` and non-empty verification evidence.
- `already_fixed` requires referenced commit that predates resolution action.
- `not_actionable` and `duplicate` require non-empty rationale.
- Any unresolved thread or unverified resolved thread yields review integrity failure.

## Merge Guard Contract

`allowMerge = true` only if all are true:

- Review integrity status is pass.
- Unresolved thread count is zero.
- Every resolved thread has verified resolution evidence/rationale.
- Required CI checks are passing.

Otherwise:

- `ao/merge-guard` must report failure.
- Merge API must return `422` with structured blockers.

## API Additions

- `GET /api/prs/[id]/review-threads`
- `POST /api/prs/[id]/review-resolutions`
- `POST /api/prs/[id]/review-resolutions/verify`
- `POST /api/prs/[id]/review-resolutions/apply`
- `POST /api/prs/[id]/merge` (extended guard enforcement)

## Persistence and Auditability

Use append-only key-value records in AO project data directory (same style as feedback reports) to store immutable resolution actions and verification transitions.

## Rollout Defaults

- `reviewIntegrity.enabled = true`
- `reviewIntegrity.mode = "enforce"`
- `reviewIntegrity.requireEvidenceForBotThreads = true`
- `mergeGuard.enabled = true`
- `mergeGuard.mode = "enforce"`
- `mergeGuard.requiredChecks = ["review-integrity", "ao/merge-guard"]`
- `mergeGuard.reverifyOnNewCommits = true`
- `mergeGuard.allowBypass = false`

## Test Matrix

### Unit

- Rule matrix for review integrity evaluator.
- Decision matrix for merge guard evaluator.

### Integration

- Propose/verify/apply API flow validation.
- Merge API blocker behavior (`422`) with machine-readable errors.
- Check-run publication behavior for `review-integrity` and `ao/merge-guard`.

### E2E

- Resolve without evidence is blocked.
- Valid fix with green checks is mergeable.
- New commit or new review activity invalidates previous verification.

## Delivery Notes

- No warn-only or observe-only mode in this delivery.
- No bypass path for AO-managed merges.
- This plan exists to anchor implementation sequencing and review discussion in PR.
