# Claude Code Model Discovery Design

## Goal

Replace AO's release-time Claude Code model list with a model catalog discovered from the user's installed and authenticated Claude Code TUI. Serve the durable cached catalog immediately, refresh it once in the background after a normal daemon boot, and use the existing six-hour revalidation window thereafter.

## Scope

- Remove the hardcoded Claude Code `sonnet`, `opus`, and `haiku` catalog.
- Discover Claude Code choices by opening `/model` in a temporary private terminal session.
- Reuse the existing `AgentModelCatalog` response, SQLite catalog cache, HTTP routes, frontend picker, and manual Refresh action.
- Warm previously cached Claude project scopes after daemon startup without blocking daemon readiness.
- Preserve the last successful catalog when discovery fails.
- Continue allowing custom Claude model values.

Codex, Muse, Amp, and every other agent catalog are outside this change. Adding a general-purpose interactive model-discovery framework is also outside this change.

## User Experience

The model picker always reads AO's stored Claude catalog first. If one exists, the picker renders it immediately. Daemon startup schedules a background refresh, so a changed Claude installation can update the picker without making application startup wait for Claude.

If no cached Claude catalog exists, the picker remains usable as a custom model input while the first discovery runs. A successful discovery replaces that fallback with the normalized model choices. A failed discovery leaves an existing catalog untouched; without an existing catalog, AO keeps the custom input and exposes the discovery warning through the existing response.

The existing manual **Refresh models** action always requests a fresh discovery. After a successful startup or manual discovery, the normal cache-first read path marks the catalog for background revalidation once its validation timestamp is more than six hours old. This is lazy revalidation on the next catalog request, not a six-hour polling timer.

## Discovery Process

Claude model discovery runs the adapter-resolved Claude executable in a private PTY using the project working directory and project environment already supplied to model discovery. AO starts Claude with accessibility-oriented terminal output and no initial prompt, waits for an empty composer, writes `/model` followed by Enter, and reads until the numbered model menu is complete and stable.

AO never selects a menu entry and never submits a user prompt. It closes the temporary terminal immediately after capture. Consequently AO does not request a model inference during discovery, although Claude may perform its own authentication and catalog network activity.

The process has a bounded timeout. Cancellation, timeout, authentication prompts, workspace-trust prompts, unexpected interaction screens, premature exit, or incomplete output are discovery failures. AO must not answer any such prompt automatically.

The implementation reuses the repository's cross-platform PTY support so Unix uses `creack/pty` and Windows uses ConPTY. Discovery owns and closes its PTY on every success and failure path.

## Parsing and Normalization

The parser consumes accessibility-mode terminal output, removes ANSI and terminal-control sequences, and recognizes a complete numbered `/model` menu. It extracts only model rows; surrounding status, pricing, and help text are ignored.

Claude displays names rather than launch values, so AO derives aliases mechanically instead of maintaining a model table:

- Ignore the `Default (recommended)` row because an empty AO selection already means Claude's default.
- Use the lower-cased model-family word as the base alias. Version text is display metadata, so `Fable 5` becomes `fable` and `Sonnet 5` becomes `sonnet`.
- Append `[1m]` when the row is explicitly marked `1M context`, so `Opus 5 (1M context)` becomes `opus[1m]`.
- Preserve the full visible row name as the picker label.
- Mark the row matching Claude's already resolved project/user model setting as the catalog default.

Parsing is all-or-nothing. AO saves a catalog only when it sees the menu boundary and every selectable row produces a unique, non-empty alias. Unknown or ambiguous row shapes fail discovery and retain the previous catalog rather than caching a partial list.

## Cache and Startup Refresh

The existing cache remains keyed by agent and project because Claude's environment and settings resolution can be project-specific. No migration or API schema change is required.

The cache port gains a read operation that lists previously cached project scopes for one agent. After the daemon finishes constructing its services, it asks the agent service to warm the cached `claude-code` scopes in the background. Scopes refresh sequentially, and the existing in-flight call coalescing prevents duplicate work with a simultaneous UI or manual request.

A persisted successful validation within the preceding ten minutes suppresses the startup refresh for that scope. This protects crash/restart loops from repeatedly launching Claude while preserving the intended once-per-normal-boot behavior. A daemon with no previously cached Claude scope performs no speculative startup probe; the first picker request discovers and creates that scope.

The executable/configuration fingerprint still invalidates a cached catalog. After startup, successful catalogs use the existing six-hour trust window. Manual refresh bypasses cache age. Discovery failure never overwrites a more useful cached catalog.

## Boundaries and Safety

- The daemon remains ready before startup discovery begins.
- Startup discoveries run sequentially and never create AO sessions or worktrees.
- Discovery sends only the literal `/model` command and Enter.
- It never approves trust, authentication, permissions, or other interactive prompts.
- Only normalized model identifiers, labels, source metadata, timestamps, and warnings enter the cache; raw terminal output is not persisted.
- Existing model-load timeouts, request coalescing, stale-cache warnings, and custom model support remain authoritative.

## Testing

Focused adapter tests use a fake PTY and recorded accessibility-mode transcripts to cover Fable, ordinary aliases, 1M-context aliases, ANSI/control sequences, fragmented reads, duplicate rows, incomplete menus, unexpected prompts, timeout, cancellation, and process cleanup.

Agent-service tests cover startup enumeration of cached Claude scopes, sequential refresh, the ten-minute restart guard, in-flight coalescing, successful cache replacement, failure preservation, first-load custom fallback, and six-hour lazy revalidation.

Storage tests cover listing cached scopes without changing the existing schema. Daemon wiring tests verify that startup warming is scheduled after service construction and does not block readiness.

Verification runs the focused model-catalog, agent-service, storage, and daemon tests; the full backend test suite; frontend typecheck; and a real AO desktop check showing that Fable appears after Claude discovery and remains available from cache after daemon restart.
