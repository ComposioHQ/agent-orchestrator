# Agent-Owned Model Catalogs Design

## Goal

Remove every release-time model-ID list from AO. Claude Code and Muse discover their installed account's choices from `/model`, while Codex reads its structured app-server `model/list`. Amp's documented execution modes remain because they are modes, not provider model IDs.

## Scope

- Remove the hardcoded Claude Code, Codex, and Muse model catalogs.
- Discover Claude Code choices from the installed Claude Code TUI and cache them.
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

Claude Code has no machine-readable model-list command. AO therefore runs the adapter-resolved Claude executable in a temporary private PTY using the project working directory and environment. It starts accessibility-oriented terminal output in Claude's safe mode, with a fresh temporary `CLAUDE_CONFIG_DIR`, waits for an empty composer, writes `/model` followed by Enter, and captures the complete stable numbered menu. Safe mode suppresses user and project hooks and other customizations during the probe; the isolated config directory keeps any provider session state out of the user's normal Claude history and is removed after the process closes.

AO never selects a menu entry, submits a user prompt, answers workspace trust or authentication, or creates an AO session. It closes the terminal immediately after capture. AO therefore requests no model inference, although Claude may perform authentication and catalog network activity.

Cancellation, timeout, unexpected interaction screens, incomplete output, or premature exit are discovery failures. The implementation reuses AO's cross-platform PTY support and owns cleanup on every path.

### Claude Parsing

The parser removes ANSI and terminal-control sequences and extracts only complete numbered model rows. It ignores `Default (recommended)` because an empty AO override already means Claude's default.

Claude shows display names instead of launch values, so AO derives aliases mechanically rather than storing a model table:

- Lowercase the model-family word; version text is display metadata (`Fable 5` becomes `fable`).
- Append `[1m]` when the row explicitly says `1M context` (`Opus 5 (1M context)` becomes `opus[1m]`).
- Preserve the visible row name as the picker label.
- Mark the row matching Claude's resolved project/user model setting as default.

Parsing is all-or-nothing. Every selectable row must yield a unique non-empty alias and the menu boundary must be present. Unknown or ambiguous output fails discovery rather than caching a partial catalog.

## Codex Discovery

Codex exposes `model/list` through its local app-server protocol. AO adds a read-only operation to the existing Codex app-server driver so model discovery initializes app-server, requests `model/list`, normalizes the response, and closes the process without creating a thread or sending a prompt.

The catalog uses provider-returned IDs, display names, default flags, and availability. Hidden entries are excluded. AO does not filter the result through a static allowlist. The discovery process uses the same resolved Codex binary and environment boundary as normal Codex app-server sessions.

Codex discovery failure follows the shared cached/manual fallback. The existing model cache and six-hour lazy revalidation apply; no separate startup refresh is required for Codex.

## Muse Discovery

Muse 0.2.1 has no non-interactive model-list command, but its installed TUI exposes `/model` as the native model picker. AO removes the static Muse Spark list and uses the same private-PTY lifecycle as Claude: start Muse with no initial prompt and session logging disabled, wait for the empty composer, submit only `/model`, capture a complete stable menu, and close without selecting a model or submitting a provider prompt.

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
- Claude Code and Muse discovery send only `/model` and Enter and never answer another prompt.
- Codex discovery sends only app-server initialization and `model/list` before closing.
- Startup work is background-only and interactive scopes run sequentially.
- Raw terminal/protocol output is not persisted; only normalized catalog data and existing metadata enter SQLite.
- Last-known-good cache, request coalescing, timeouts, warnings, and custom model support remain authoritative.
- Amp modes remain the only static picker values among these four agents, explicitly classified as a mode enum rather than a model catalog.

## Testing

Claude adapter tests use a fake PTY and recorded accessibility transcripts to cover Fable, ordinary aliases, 1M aliases, ANSI/control sequences, fragmented reads, duplicates, incomplete menus, unexpected prompts, timeout, cancellation, and cleanup.

Muse adapter tests use a fake PTY and recorded `/model` transcripts to cover explicit IDs, labels, providers, defaults, fragmented output, stale-broker/authentication errors, ambiguous label-only rows, timeout, cancellation, session-log disabling, and cleanup.

Codex adapter tests use a fake app-server transport to prove that `model/list` returns provider IDs, names, defaults, and hidden filtering without starting a thread. They also cover protocol errors, timeout, and process cleanup.

Model-catalog tests prove that Claude, Codex, and Muse no longer receive bundled model IDs; both interactive agents return manual selection only when discovery has no cache; Amp remains a mode list; and existing command-discovered agents are unchanged.

Agent-service tests cover cache-first reads, successful replacement, failure preservation, six-hour lazy revalidation, in-flight coalescing, Claude/Muse startup scope enumeration, sequential warmup, and the ten-minute restart guard. Storage tests cover listing cached scopes without a schema change. Daemon tests prove startup warming is scheduled after construction and does not block readiness.

Verification runs focused adapter, model-catalog, service, storage, and daemon tests; the complete backend suite; frontend typecheck; and real AO desktop checks confirming Claude Fable, the live Codex catalog, and Muse's native model choices appear; cached catalogs survive restart; failure retains prior choices; and Amp modes remain unchanged.
