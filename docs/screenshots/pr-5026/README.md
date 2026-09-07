# Board token-count verification

These screenshots were captured from the native Electron app running this branch against an isolated local daemon on port `5326`.

- `electron-board-edge-cases.png` — positive token count with cost, cost-only fallback, no telemetry, and zero tokens with cost.
- `electron-board-large-count.png` — the same cases plus a `1.2M` compact token-count case.

The verification rows lived only in `/tmp/ao-verify-5026` and are not part of the application data or source tree.
