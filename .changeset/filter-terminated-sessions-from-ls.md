---
"@aoagents/ao-cli": minor
"@aoagents/ao-core": patch
---

`ao session ls` and `ao status` now hide terminated sessions (`killed`, `terminated`, `done`, `merged`, `errored`, `cleanup`) by default. A dim footer reports how many were hidden and how to surface them. Pass `--include-terminated` to restore the previous unfiltered output.

Core change: `parseCanonicalLifecycle()` now preserves `pr.state="merged"` when reconstructing legacy metadata with `status=merged` but no `pr=` URL (previously collapsed to `pr.state="none"`, which made `isTerminalSession()` return false for those sessions). Also exports `sessionFromMetadata` so consumers can round-trip flat metadata through the canonical lifecycle.

**Breaking — JSON output shape:** `ao session ls --json` and `ao status --json` now emit `{ data: [...], meta: { hiddenTerminatedCount: number } }` instead of a bare array. Scripts consuming the JSON must read `.data` for the session list. `--include-terminated` restores full data and reports `hiddenTerminatedCount: 0`.

The existing `-a, --all` flag still only governs orchestrator visibility on `ao session ls` — it does **not** re-enable terminated sessions. Combine with `--include-terminated` when you want both.
