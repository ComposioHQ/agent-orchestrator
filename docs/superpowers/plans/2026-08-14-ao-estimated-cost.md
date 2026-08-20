# AO Estimated Cost Implementation Plan

**Goal:** Ship reviewed, provider-correct estimated usage costs end to end in one feature PR based on current `main`.

## Global constraints

- Installed AO clients fetch only the reviewed AO GitHub catalog at `https://raw.githubusercontent.com/Untrivial-ai/agent-orchestrator/main/pricing/catalog/v1/manifest.json`; they never contact LiteLLM directly and no catalog is embedded in release artifacts.
- The initial catalog contains exactly `anthropic`, `openai`, and `zai`, accepts LiteLLM `chat` and `responses` records, and stores immutable content-addressed provider blobs.
- Pricing resolves an exact canonical `(provider_id, model_id)` and never derives the billing provider from the CLI harness or uses fuzzy/cross-provider matching.
- Store exact per-event component and total estimates in integer nano-USD. A non-null total, including zero, is immutable. Reasoning is already part of output and is never priced twice.
- Existing token-only rows are attributed only by an exact reparse of their original durable source event. Missing or unverifiable history stays unknown; never guess from harness.
- API cost coverage is independent of token collection integrity. UI copy is exactly **Estimated cost**, using `≈` for complete, `≥` for partial, and no internal “direct API lower bound” language.
- Summary remains the default session inspector view. Automated browser/preview activity may badge Browser but must not open it or steal focus.
- Use strict TDD for every behavior change, generated files only through `npm run sqlc` / `npm run api`, and no external network in tests.
- Do not cherry-pick the old cost-estimation branch; current-main code and tests are authoritative.

## Task 1: Deterministic AO catalog and daily catalog PR workflows

Add `backend/cmd/pricingcatalog` (`sync`, `validate`) and a pure catalog-sync package. Decode upstream with `UseNumber`, use exact rational decimal normalization, preserve explicit zero, require nonnegative input/output rates, include only `anthropic`, `openai`, `zai` and modes `chat`, `responses`, canonicalize identifiers deterministically, deduplicate identical records, reject conflicting duplicates, ignore tier/batch/region/priority/reasoning-specific rates, sort deterministically, and avoid timestamps.

Write `pricing/catalog/v1/manifest.json` and append-only `providers/<provider>/<sha256>.json`. Provider blobs contain `uncachedInputUsdPerToken`, optional `cacheReadUsdPerToken`, optional `cacheWriteUsdPerToken`, optional `cacheWrite1hUsdPerToken`, and `outputUsdPerToken`. Hash exact canonical bytes including the trailing newline; keep `version`, hash, path, and model count only in the manifest with version `ao-catalog:<provider>:sha256:<hash>`. Generate the initial three-provider catalog from a pinned LiteLLM SHA.

Add a canonical-repo-only daily/manual sync workflow (`17 3 * * *` UTC) and a read-only pull-request validator. The sync resolves LiteLLM main to a SHA, downloads at most 32 MiB, generates/validates, exits on semantic no-op, and creates/updates `automation/pricing-catalog` with PR title `chore(pricing): refresh LiteLLM catalog`; never auto-merge. The workflow starts from canonical `Untrivial-ai/agent-orchestrator:main`, pushes the automation branch to `whoisasx/agent-orchestrator`, and opens a cross-fork pull request back to canonical `main`. Authenticate the fork checkout, branch push, and PR creation with repository secret `PRICING_CATALOG_PAT`, containing a fine-grained PAT restricted to the `whoisasx/agent-orchestrator` fork with Contents and Pull requests read/write access; the PAT has no write access to the canonical repository. Add `pricing/**` to relevant Go workflow filters. Tests cover deterministic output, scientific notation, zeros, duplicates, filters, idempotency, paths, hashes, versions, counts, and schemas.

## Task 2: Provider attribution, cache-write splits, and durable pricing schema

Create migrations `0102_usage_cost_estimation.sql` and `0103_usage_cost_candidate_canonical_index.sql`, append them to the shipped ledger, and never edit migration 0052. Add `usage_bindings.provider_hint`. Add nullable event `provider_id`, nullable 5m/1h cache-write token splits, nullable four component costs, nullable total, and non-null empty-default `pricing_version`, plus the provider/version candidate index. Existing rows remain null-attributed and unpriced.

Extend hook/domain/store contracts. Claude hook route hints: default/API Anthropic -> `anthropic`; official `api.z.ai` -> `zai`; Bedrock -> `bedrock`; Vertex -> `vertex_ai`; conflicting/unknown custom routing -> empty. Persist only the canonical ID, never a URL. Claude event precedence is message provider, record provider, retained native provider, trusted hook hint, then `unknown`. Codex retains `session_meta.payload.model_provider` for subsequent events in parser-state v1. Lookup canonicalization trims/lowercases and strips at most one exact provider prefix; explicit alias `z.ai` -> `zai`; observation retains source facts.

Persist valid Claude 5m/1h splits only when both are nonnegative and sum to generic cache-write tokens. On absent/malformed splits retain the generic token event, leave splits null, and mark malformed input as an anomaly. Replay source equality includes provider/splits for new rows but excludes all costs/version; legacy null-provider rows retain token-only replay compatibility. Run sqlc. Tests cover precedence, routing, provider/model changes, split shapes, persistence, migration compatibility, replay, and no credential/URL persistence.

## Task 3: Pricing catalog runtime, exact estimator, LKG cache, and refresher

Add strict manifest/provider decoding, immutable snapshots, canonical exact provider/model lookup, exact rational estimator, provider activations, and a context-aware activation fence. Estimate uncached input, cache read, combined cache write, and output; round each component half-up to nano-USD with checked `int64` arithmetic. Zero-token buckets are known zero. Positive buckets with absent rates are unknown. Anthropic split cache writes use default/5m plus 1h rates; positive Anthropic cache write without a trusted split is unknown. Total is set only when all four components are known.

Add an injected fixed-origin HTTP client and LKG cache at `<AO_DATA_DIR>/pricing/catalog/v1/`. Limits: 1 MiB manifest, 8 MiB provider, 20-second timeout. Support ETag/304, reject unsafe/absolute paths and cross-origin redirects, validate the complete candidate, install immutable blobs first and atomically replace manifest last using private permissions. Keep old cache/snapshot on every failure.

Start with synchronous LKG activation and asynchronous first refresh; poll every 24h with ±5% jitter; retry failures 1m, 2m, 4m up to 1h. Do not overlap refreshes or affect daemon health. Delay cached-provider backfill delivery until the first remote attempt completes; changed remote supersedes cached pending, while 304/failure permits cached activation. Tests use fixtures/httptest and cover decoding, arithmetic, overflow, HTTP bounds/redirects/cancellation, corrupt/missing LKG, atomic commit recovery, timing/jitter/backoff, startup ordering, and shutdown.

## Task 4: Atomic ingestion pricing, historical attribution repair, and bounded backfill

Wire the ingestor, snapshot manager, and activations through the same context-aware fence: snapshot read, estimation, and `ApplyUsageChunk` occur before release; activation swaps the snapshot through the fence and runs enrichment afterward.

Add a background legacy repair that finds null-provider events by source, reparses only the already-ingested durable prefix without moving cursor/state, and CAS-updates provider/splits only when event key, model, and generic token vector exactly match. Price repaired events immediately under the same fence. Missing/replaced/mismatched sources stay unknown.

Add one coalescing provider backfiller. Select exact-provider, total-null events whose attempted version differs, in stable batches of exactly 256. CAS on event ID, expected version, and total-null; stamp the active version even when rates/model are unavailable; retry only on provider version change; never update a non-null total. Touch each affected binding once per transaction for existing CDC. Newer provider jobs supersede queued older work. Lock admission and shutdown are cancellation-aware. Tests cover deterministic activation/insert races, legacy repair success/refusal, >256 batching, same/new version behavior, zero immutability, CAS races, CDC, restart, superseding activations, and cancellation.

## Task 5: Coverage-aware storage aggregation and generated API contract

Group detail by `(harness, COALESCE(provider_id,'unknown'), model_id)` and keep compact output one row per session. Aggregate event/fully-priced/known-component counts, full total sums, and four separate known component sums only for total-null events. Partial lower bound is full totals plus known components from total-null rows; never double count. Use SQLite overflow errors and checked Go addition across columns/groups. Complete means all events total-priced; partial means a positive known lower bound but not complete; otherwise unavailable. Token `Incomplete` remains independent.

Add nullable reusable `estimatedCost` to compact and all detailed totals: non-null `totalNanos`, nullable four component nanos, and coverage `complete|partial`; unavailable serializes as explicit null and known zero remains valid. Add `providerId` to model responses and expose no aggregate pricing version. Update DTO/spec registry/controller mappings, run sqlc/API generation, and commit all generated artifacts. Tests cover complete/partial/unavailable, lower-bound preservation, no double counting, zero, null components, provider separation, multiple agents/models/bindings, overflow, batch-query behavior, and compact/detail parity.

## Task 6: Dashboard, Summary inspector, attribution display, and browser focus regression

Add one shared cost formatter: complete `≈`, partial `≥`, zero `$0.00`, preserve significant digits below one cent, unavailable no cost. Dashboard presentation is `<cost> · <tokens>` or tokens only. Tooltip heading is exactly `Estimated cost`; rows are Input, Cache read, Cache write, Output; null components show `—`; never show “direct API lower bound”.

Add a detailed session-usage hook using the existing usage query root. Render an Estimated cost section through the Summary usage slot with total, four components, and compact `providerId · modelId` rows. Do not add a Cost tab. Add keys to all eight locale catalogs.

Entering a session always selects Summary. Automated preview revision or agent-browser activity only marks Browser unseen; it must not open the inspector or change its view. Explicit user link actions may open Browser. Tests cover all formatter states, active/archived cards, tooltip copy/components, inspector loading/error/coverage/attribution, translations, Summary default, and Browser badge without focus theft.

## Task 7: Whole-feature verification, real-app smoke test, and final review

Regenerate sqlc/API and prove no drift. Run focused package tests, frontend tests, typecheck, `npm run lint`, backend build, relevant/full race tests, vet, and `npx @redwoodjs/agent-ci run --all` when Docker is available. Seed an isolated `AO_DATA_DIR` with the generated catalog, launch the real desktop app, and verify Dashboard and Summary inspector with `ao preview`; do not touch the user's normal AO data. Record any environment-only limitation precisely.

Conduct a whole-branch spec and quality review against this plan, fix all Critical/Important findings with regression tests, re-review once, and leave the branch clean and ready for the user's integration choice. The feature remains one PR; future daily catalog updates are bot PRs.
