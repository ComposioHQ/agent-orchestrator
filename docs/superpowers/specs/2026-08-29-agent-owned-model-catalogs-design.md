# Agent-Owned Model Catalogs Design

## Goal

Remove every release-time model-ID list from AO. Claude Code ships a static catalog snapshot mirroring the model choices its ACP sessions advertise, Muse uses `/model`, and Codex reads its structured app-server `model/list`. Amp's documented execution modes remain because they are modes, not provider model IDs.

## Scope

- Remove the hardcoded Codex and Muse model catalogs.
- Ship a static Claude Code catalog snapshot mirroring its ACP session model choices, refreshed manually when advertised models change.
- Discover Codex choices from the installed Codex app-server protocol and cache them.
- Discover Muse choices from the installed Muse TUI and cache them.
- Reuse the existing `AgentModelCatalog` response, SQLite cache, HTTP routes, frontend controls, and manual Refresh action.
- Warm previously cached Claude Code and Muse project scopes after daemon startup without blocking readiness.
- Preserve the last successful agent-provided catalog when discovery fails.

Changing Amp's `low`, `medium`, `high`, and `ultra` mode enum is outside this change. Those values form the CLI's `--mode` contract and do not identify provider models. Other agents already use CLI discovery or free text and remain unchanged.

## Source Policy

AO chooses a catalog source in this order:

1. A documented machine-readable command owned by the agent.
2. A structured local protocol owned by the agent.
3. A narrowly scoped interactive probe when the user has explicitly accepted that compatibility tradeoff.
4. Unrestricted free-text entry when no reliable discovery surface exists.

AO does not fall back to a bundled model-ID table. A failed discovery returns the last successful cache; without one, it returns the manual text catalog and a warning.

## Claude Code Discovery

Claude Code has no machine-readable model-list command. Rather than spawn the Claude Agent SDK per discovery, AO ships a static catalog that mirrors the model choices a Claude Code ACP session advertises through `session/new`. The snapshot is captured from a live ACP session and refreshed manually when Claude Code's advertised models change.

Discovery never launches the Agent SDK, an interactive Claude client, or a provider turn; it returns the static list immediately. The row matching Claude's resolved project/user model setting is marked as default. An empty AO override means Claude's default, so the ACP `default` meta-entry is not duplicated as a picker row.

Because the list is static, discovery cannot fail on auth, timeout, or an empty catalog. Binary-version and configured-model fingerprints still invalidate the cache so a settings edit updates the default marker.

## Codex Discovery

Codex exposes `model/list` through its local app-server protocol. AO adds a read-only operation to the existing Codex app-server driver so model discovery initializes app-server, requests `model/list`, normalizes the response, and closes the process without creating a thread or sending a prompt.

The catalog uses provider-returned IDs, display names, default flags, and availability. Hidden entries are excluded. AO does not filter the result through a static allowlist. The discovery process uses the same resolved Codex binary and environment boundary as normal Codex app-server sessions.

Codex discovery failure follows the shared cached/manual fallback. The existing model cache and six-hour lazy revalidation apply; no separate startup refresh is required for Codex.

## Muse Discovery

Muse 0.2.1 has no non-interactive model-list command, but its installed TUI exposes `/model` as the native model picker. AO removes the static Muse Spark list and uses a private PTY: start Muse with no initial prompt and session logging disabled, wait for the empty composer, submit only `/model`, capture a complete stable menu, and close without selecting a model or submitting a provider prompt.

Muse has its own parser because its menu layout and launch values are agent-owned and need not match Claude's alias conventions. AO records only model identifiers that the menu exposes unambiguously. It preserves Muse's display label, provider information, and default marker when present. If a row exposes only a display name with no reliable `--model` value, discovery fails all-or-nothing rather than inventing an identifier.

Authentication, stale local broker state, workspace interaction, timeout, incomplete menus, and process exit follow the shared failure policy: retain the last successful cache, otherwise expose unrestricted text entry with a warning. Muse discovery does not repair or terminate existing Muse sessions.

## Cache and Refresh

Catalogs remain keyed by agent and project because environment, configuration, authentication, and resolved defaults may be project-specific. No database migration, API schema change, or frontend component change is required.

For normal reads, AO returns the valid stored catalog immediately. A binary or relevant configuration fingerprint change invalidates it. Successful discovered catalogs use the existing six-hour trust window; once expired, the next catalog request serves cache first and triggers background revalidation. Manual Refresh forces discovery. In-flight loads for the same agent/project/mode remain coalesced.

### Interactive Startup Warm

The cache port gains a read operation that lists previously cached project scopes for an agent. After daemon services are constructed, AO warms cached Claude Code and Muse scopes asynchronously and sequentially. Daemon readiness never waits for either agent.

A successful validation within the preceding ten minutes suppresses startup refresh for that scope, preventing crash/restart loops. A daemon with no previously cached scope for an interactive agent performs no speculative probe; the first picker request creates it. Discovery failure cannot replace a more useful cached catalog.

Codex relies on fingerprint invalidation and six-hour/manual refresh rather than startup warming.

## Boundaries and Safety

- No discovery starts an AO session, worktree, or provider turn.
- Claude Code discovery launches no SDK or interactive client; Muse sends only `/model` and Enter.
- Codex discovery sends only app-server initialization and `model/list` before closing.
- Startup work is background-only and interactive scopes run sequentially.
- Raw terminal/protocol output is not persisted; only normalized catalog data and existing metadata enter SQLite.
- Last-known-good cache, request coalescing, timeouts, warnings, and custom model support remain authoritative.
- Amp modes remain the only static picker values among these four agents, explicitly classified as a mode enum rather than a model catalog.

## Testing

Claude model-catalog tests assert the static catalog is returned without launching the Agent SDK or a terminal, and that the configured-model default marker is applied.

Muse adapter tests use a fake PTY and recorded `/model` transcripts to cover explicit IDs, labels, providers, defaults, fragmented output, stale-broker/authentication errors, ambiguous label-only rows, timeout, cancellation, session-log disabling, and cleanup.

Codex adapter tests use a fake app-server transport to prove that `model/list` returns provider IDs, names, defaults, and hidden filtering without starting a thread. They also cover protocol errors, timeout, and process cleanup.

Model-catalog tests prove that Claude returns the static catalog without the terminal spawner or Agent SDK; Codex and Muse no longer receive bundled model IDs; discovery returns manual selection only when it has no cache; Amp remains a mode list; and existing command-discovered agents are unchanged.

Agent-service tests cover cache-first reads, successful replacement, failure preservation, six-hour lazy revalidation, in-flight coalescing, Claude/Muse startup scope enumeration, sequential warmup, and the ten-minute restart guard. Storage tests cover listing cached scopes without a schema change. Daemon tests prove startup warming is scheduled after construction and does not block readiness.

Verification runs focused adapter, model-catalog, service, storage, and daemon tests; the complete backend suite; frontend typecheck; and real AO desktop checks confirming Claude Fable, the live Codex catalog, and Muse's native model choices appear; cached catalogs survive restart; failure retains prior choices; and Amp modes remain unchanged.
