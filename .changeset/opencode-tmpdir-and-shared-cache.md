---
"@aoagents/ao-core": patch
"@aoagents/ao-cli": patch
"@aoagents/ao-plugin-agent-opencode": patch
---

opencode: bound /tmp blast radius and consolidate session-list cache

Addresses review feedback on PR #1478:

- **TMPDIR isolation.** Every `opencode` child we spawn now points at
  `~/.agent-orchestrator/.bun-tmp/` via `TMPDIR`/`TMP`/`TEMP`. Bun's
  embedded shared-library extraction lands there instead of the system
  `/tmp`, so the cli janitor only ever sweeps AO-owned files. Other
  users' or other applications' Bun artifacts on a shared host can no
  longer be touched by the regex.
- **Single shared session-list cache.** Core and the agent-opencode
  plugin previously kept independent caches; per poll cycle the system
  spawned at least two `opencode session list` processes instead of
  one. Both consumers now use the shared cache exported from
  `@aoagents/ao-core` (`getCachedOpenCodeSessionList`).
- **TTL no longer covers the send-confirmation loop.** The cache TTL
  dropped from 3s to 500ms so the
  `updatedAt > baselineUpdatedAt` delivery signal in
  `sendWithConfirmation` actually fires. Concurrent callers still
  share the in-flight promise.
- **Delete invalidates the cache.** `deleteOpenCodeSession` now calls
  `invalidateOpenCodeSessionListCache()` on success so reuse, remap,
  and restore code paths cannot observe a deleted session id within
  the TTL window.
- **Janitor reliability.** `sweepOnce` now filters synchronously
  before allocating per-file promises (matters on hosts with thousands
  of `/tmp` entries), and `stopBunTmpJanitor()` is now async and awaits
  any in-flight sweep so SIGTERM cannot exit while `unlink` is mid-flight.
- **Janitor observability.** The sweep callback in `ao start` now logs
  successful reclaims, not just errors, so operators can confirm the
  janitor is doing useful work.
