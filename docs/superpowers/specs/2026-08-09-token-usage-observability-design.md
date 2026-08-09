# Multi-Agent Token Usage Observability Design

## Goal

Extend AO's existing append-only token usage pipeline from Claude Code and
Codex to GitHub Copilot, Grok, Kimi Code, Pi, and Qwen Code without adding
monetary cost calculation. Droid remains explicitly unsupported until its TUI
exposes reliable session-level token events.

## Scope

This work covers terminal-UI sessions supervised by AO. Existing Chat-mode
conversation usage remains independent and unchanged.

The user-facing token vocabulary remains:

- inclusive input tokens;
- uncached input tokens;
- cache-read tokens;
- cache-write tokens;
- inclusive output tokens; and
- reasoning tokens when the native source reports them separately.

Missing native metrics remain distinguishable from a reported zero wherever
the aggregate API already supports availability metadata. Total tokens remain
`input_tokens + output_tokens`; cache and reasoning subsets are never added a
second time.

Monetary prices, billing APIs, currencies, credit balances, and cost estimates
are out of scope. The existing frontend cost placeholder and the optional
Chat-provider cost field are not connected to this work.

## Approaches Considered

### 1. Provider adapters feeding the existing pipeline (selected)

Each certified native artifact gets a source kind, parser, discovery strategy,
and parser state. All adapters emit the existing `ModelUsageEvent` token vector
into the current durable cursor, idempotency, aggregation, and integrity
machinery.

This preserves the rewrite architecture and keeps provider-specific semantics
at the ingestion boundary. It also permits cumulative sources such as Copilot
and append-only per-turn sources such as Kimi to share storage safely.

### 2. One generic configurable JSON parser

A data-driven field mapping could reduce parser code, but it cannot naturally
express cumulative baselines, duplicate shutdown summaries, nested subagent
files, monthly shared logs, or Grok's OTEL transport. It would move complexity
into an implicit configuration language and make source-format validation less
clear.

### 3. Independent collector and storage path per provider

Separate pipelines would isolate providers but duplicate cursor handling,
rotation detection, retry behavior, event idempotency, integrity state, API
aggregation, and frontend invalidation. This conflicts with AO's existing
usage boundary and would be harder to keep consistent.

## Architecture

The existing usage pipeline stays authoritative:

1. AO binds an AO session to a native agent session identifier.
2. A provider adapter registers one or more validated source artifacts.
3. The watcher schedules changed sources.
4. The ingestor reads bounded chunks from durable byte offsets.
5. A provider parser normalizes native records into append-only
   `ModelUsageEvent` values.
6. SQLite deduplicates events by stable source event key.
7. Existing service summaries and API responses aggregate the canonical token
   vector by harness and model.

Provider differences are represented explicitly rather than inferred in a
generic parser. File-based sources use the existing watcher. Grok uses a small
opt-in OTLP receiver that binds only to `127.0.0.1`; it feeds the same
normalization/storage boundary and is never attached to the mobile LAN router.
The receiver writes validated, content-free API-usage envelopes to an AO-owned
per-session JSONL spool under `AO_DATA_DIR`; the normal watcher, durable cursor,
and parser then ingest that spool instead of creating a second write path.

The database receives a new migration that rebuilds the usage tables with the
additional harness and source-kind checks. Already-merged migration 0052 is not
modified. Generated sqlc code is regenerated only if source queries change.

## Provider Sources and Normalization

### Claude Code

No source-discovery change. Preserve the current completed-message and
subagent behavior:

```text
input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
uncached = input_tokens
cache_read = cache_read_input_tokens
cache_write = cache_creation_input_tokens
output = output_tokens
reasoning = unavailable
```

The cache-write TTL split is not required for token-only observability.

### Codex

No source-discovery change. Preserve cumulative-counter delta processing:

```text
input = delta(input_tokens)
uncached = input - cache_read - cache_write
cache_read = delta(cached_input_tokens)
cache_write = delta(cache_write_input_tokens)
output = delta(output_tokens)
reasoning = delta(reasoning_output_tokens)
```

### GitHub Copilot

Use the hook-captured native UUID to register
`~/.copilot/session-state/<uuid>/events.jsonl`. Parse cumulative per-model
`session.shutdown.data.modelMetrics` summaries. Maintain the last vector per
model in parser state so repeated shutdown records produce no duplicate usage
and increased summaries emit only their delta.

```text
input = usage.inputTokens
uncached = input - cacheReadTokens - cacheWriteTokens
cache_read = usage.cacheReadTokens
cache_write = usage.cacheWriteTokens
output = usage.outputTokens
reasoning = usage.reasoningTokens
```

Invalid non-monotonic per-model counters reset that model's baseline, increment
the source anomaly count, and emit no negative delta.

### Kimi Code

Use Kimi's AO-managed home and hook-captured native session ID to discover the
session directory. Register every `agents/*/wire.jsonl` source so root and
subagent usage are included. Parse append-only `usage.record` values.

```text
input = inputOther + inputCacheRead + inputCacheCreation
uncached = inputOther
cache_read = inputCacheRead
cache_write = inputCacheCreation
output = output
reasoning = unavailable
```

The agent directory identity participates in the stable event key.

### Pi

Pi has no native lifecycle hook suitable for source binding. Discover session
JSONL files from Pi's session directory by matching the durable session header
`cwd` to AO's unique registered worktree, then bind the header session ID.
Parse assistant-message usage values.

```text
input = input + cacheRead + cacheWrite
uncached = input
cache_read = cacheRead
cache_write = cacheWrite
output = output
reasoning = unavailable
```

Any native monetary fields are ignored.

### Qwen Code

Use the hook-captured `session_id` and register the active monthly
`~/.qwen/usage/token-usage-YYYY-MM.jsonl` file. Because that file contains
multiple sessions, the parser accepts only records matching the binding's
native session ID. The collector registers a new monthly file when the session
crosses a month boundary.

```text
input = inputTokens
uncached = inputTokens - cachedTokens
cache_read = cachedTokens
cache_write = unavailable
output = outputTokens
reasoning = thoughtsTokens
```

All records for the session are counted, including managed helper sources,
because they consume model tokens on behalf of that session.

### Grok

Enable only for AO-launched Grok sessions after explicit user opt-in. AO sets
Grok's external telemetry variables to an AO-owned loopback OTLP endpoint and
does not request prompt or tool content. Parse `grok_code.api_request` events
and correlate their `session.id` to the hook-captured native session ID.

```text
input = input_tokens
uncached = input_tokens - cache_read_tokens
cache_read = cache_read_tokens
cache_write = unavailable
output = output_tokens
reasoning = reasoning_tokens
```

The receiver rejects non-loopback traffic, unknown schema versions, records
without a matching active AO binding, and oversized payloads.

### Droid

Droid's current TUI transcript summary count is not ingested. It is a context
summary size rather than reliable cumulative request usage. AO reports usage
as unavailable for Droid. A later design may consume documented Droid Exec or
verified OTEL token events once they can be correlated to the same native TUI
session.

## Source Discovery and Hook Metadata

The hook command currently forwards usage-specific metadata only for Claude
Code and Codex. It will be generalized to accept bounded native session IDs,
model IDs, and transcript paths for every certified hook-capable harness while
retaining per-provider validation.

Provider-owned source roots are added to `SourceRoots`. Every registered file
must remain under its declared provider root, be a regular file, and pass the
existing identity and replacement checks. Shared files, such as Qwen's monthly
log, still get one logical source per AO binding; parser filtering prevents
cross-session attribution.

## Storage and Compatibility

A new migration rebuilds `usage_bindings` and `usage_sources` to admit:

- harnesses `copilot`, `grok`, `kimi`, `pi`, and `qwen` using their existing
  canonical `AgentHarness` strings; and
- source kinds for Copilot shutdown summaries, Grok OTEL API requests, Kimi
  wire logs, Pi sessions, and Qwen monthly usage logs.

The `model_usage_events` token columns and API DTOs remain unchanged. When a
source does not expose a metric, a harness/source capability matrix makes the
corresponding aggregate API pointer nil rather than presenting an unavailable
metric as a reported zero. Native zeroes remain zero. The event table continues
to use zero for unavailable non-null token columns internally; availability is
derived at service read time from the certified source semantics. Reasoning
continues to use its existing nullable event column.

Existing Claude and Codex bindings, cursors, events, and aggregate results must
survive the migration unchanged.

## Error Handling and Integrity

- Malformed or negative usage records increment the existing anomaly count and
  do not emit an event.
- Cumulative counter regressions establish a new baseline without emitting a
  negative delta.
- A shared-log record for another session is ignored, not treated as malformed.
- Duplicate native event identifiers or repeated cumulative summaries are
  idempotent.
- Missing or rotated files use the existing retry and source-generation paths.
- Unsupported source formats retain the existing safe error code and mark the
  session aggregate incomplete.
- A provider is added to `SupportedHarness` only when binding, discovery,
  parsing, replay, and aggregation tests pass.

## Frontend Behavior

The existing token summary and detailed metric components remain the rendering
surface. Once a harness is certified, its session/model rows appear through the
same API response as Claude and Codex.

The token usage section may be made generally visible once all backend sources
in this branch are certified. Unsupported Droid sessions show an explicit
usage-unavailable state rather than a fabricated zero. The cost placeholder is
not implemented or populated by this work.

## Testing Strategy

Every provider is developed test-first with sanitized golden records matching
the inspected native format. Tests cover:

- canonical field normalization;
- missing optional fields and zero values;
- malformed and negative values;
- stable event-key replay;
- cumulative duplicate and reset behavior where applicable;
- session filtering for shared logs;
- subagent attribution where applicable;
- source discovery and provider-root path rejection;
- finalization and restart from durable cursors;
- SQLite migration preservation and new CHECK constraints;
- aggregate API compatibility; and
- frontend rendering for supported and unavailable harnesses.

Focused package tests run after each red-green cycle. Final verification uses
the backend usage, storage, and HTTP tests plus frontend typecheck and relevant
component tests.

## Delivery

Work remains on `feat/token-usage-observability`. Commits are kept reviewable:
schema/framework first, then one provider per commit, Grok transport separately,
and frontend exposure last. No release, publish, or pull request is part of this
implementation unless separately requested.

Because Grok introduces a loopback protocol receiver while the other additions
are file adapters, implementation is split into two independently reviewable
plans on the same branch: file-backed providers first, then Grok OTEL. Each plan
must leave AO in a working, testable state.
