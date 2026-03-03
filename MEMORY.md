# Session Memory

- OpenCode SDK parity work uses an execute -> commit -> simplify (@claude) -> commit loop per slice.
- `readMetadataRaw(...)` must be used for OpenCode-specific keys (`opencodeMode`, `opencodeServerUrl`, `opencodeSessionId`, `terminalMode`), because `readMetadata(...)` only maps the legacy typed subset.
- Before running integration tests that import workspace packages, build outputs are required:
  - `pnpm --filter @composio/ao-core build`
  - `pnpm --filter @composio/ao-plugin-agent-opencode build`
- `T04` is the slowest live test; polling OpenCode session status reduces flakiness after `sessionManager.send(...)`.
- Current OpenCode SDK E2E suite status: T00-T08 and T12 implemented and passing; T09-T11 remain.
