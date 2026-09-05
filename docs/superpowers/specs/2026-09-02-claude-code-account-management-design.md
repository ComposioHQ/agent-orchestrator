# Claude Code Multi-Account Management Design

## Status

Design for follow-on implementation on `codex/codex-account-management`. The
Codex implementation remains provider-specific; Claude Code receives a sibling
subsystem that follows the same daemon/API boundaries without copying Codex's
session restart policy.

## Goal

Let a macOS user add, reauthenticate, locally sign out, delete, and switch
Claude Code subscription accounts. Adding an account must leave the current
device account active. Switching is device-global and hot: AO does not fork,
stop, or resume Claude conversations and does not impose an artificial wait.

## State and secret ownership

```text
~/.ao/harnesses/claude-code/
|-- accounts/<account-uuid>/account.json
|-- pending-accounts/<operation-id>/
|   |-- config/
|   `-- auth/
`-- switch-staging/<switch-id>/
```

Descriptors contain only an allowlisted account identity and timestamps.
OAuth material remains in macOS Keychain:

- Claude's canonical item uses service `Claude Code-credentials` and Claude's
  normal username-derived account key.
- AO's account vault uses service `Agent Orchestrator Claude Accounts` and the
  Claude account UUID as the Keychain account.
- Temporary rollback data uses service
  `Agent Orchestrator Claude Switch Rollbacks` and the switch UUID.

No secret bytes or Keychain identities cross the domain, SQLite, API, logging,
telemetry, or renderer boundaries.

Version one mirrors Claude's native default Keychain access policy and does not
inject a `security add-generic-password -T` trusted-application list. Restricting
the item to specific binaries requires live compatibility coverage for the
Claude CLI, Claude Desktop, and their updater-managed executable paths; adding
an incomplete allowlist could lock supported Claude clients out of the account.
AO still sends credential bytes only through `security -i` stdin so secrets do
not appear in process arguments.

## Adding and reauthenticating accounts

AO opens a trusted shell terminal running `claude auth login` with an isolated
`CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`. Claude derives the
isolated Keychain service by NFC-normalizing the raw secure-storage path,
SHA-256 hashing it, and appending the first eight hex characters to
`Claude Code-credentials-`.

After login, AO runs `claude auth status --json` in the same environment,
requires `loggedIn: true`, matches `oauthAccount.accountUuid`, and transfers
account-owned fields into AO's Keychain vault. The canonical credential and
`~/.claude.json` are not changed by Add. Reauthentication requires the selected
UUID; active-account reauthentication updates the canonical credential under
the same switch locks.

## Credential ownership and activation

The account vault owns `claudeAiOauth`, `trustedDeviceToken`, and unknown
non-shared siblings. Activation preserves only the live machine-shared
allowlist: `mcpOAuth`, `mcpOAuthClientConfig`, `mcpXaaIdp`,
`mcpXaaIdpConfig`, and `pluginSecrets`. This prevents account-bound device or
future fields from leaking across accounts while keeping shared integrations
current.

AO cooperates with Claude's proper-lockfile protocol. It acquires
`~/.claude/.oauth_refresh.lock`, then `~/.claude.lock`, both with a 60-second
stale threshold, and uses `~/.claude.json.lock` with a 10-second threshold for
identity writes. Locks are touched every three seconds and have a bounded
nine-second acquisition budget.

## Durable hot switch

```text
verify target in isolated staging
    -> acquire AO exclusive admission
    -> acquire Claude credential locks
    -> snapshot canonical credential and identity in rollback Keychain item
    -> checkpoint the latest source credential
    -> merge target account fields with live shared fields
    -> replace canonical Keychain item
    -> patch only oauthAccount in ~/.claude.json
    -> verify normal Claude auth and target identity
    -> CAS the active account pointer
    -> return immediately
```

Switch phases are `requested`, `verifying_target`, `checkpointing_source`,
`activating_target`, `updating_identity`, `verifying_global`,
`rollback_required`, `recovery_required`, `completed`, and `failed`.
Completed switches expose `propagationUncertainUntil`, 30 seconds after commit.
This is a local credential-cache uncertainty window, not a forced delay or
server-side refresh schedule.

On restart, a nonterminal switch reacquires exclusive admission. A canonical
target identity completes the active-pointer CAS; a source identity fails
safely; an unknown identity restores the rollback snapshot. Unverifiable
rollback enters `recovery_required` and continues blocking new AO-owned Claude
controller admission.

## Session and usage semantics

Running Claude TUI, Chat, and reviewer controllers are not restarted. Their
native UUIDs, ACP conversation IDs, worktrees, and transcript roots remain
unchanged. Default-store standalone Claude processes and integrations observe
the new credential after their local cache refreshes; isolated profiles and
environment-authenticated processes are unaffected.

Because the AO session and native usage binding do not change, historical
usage is not re-counted. Existing source cursors and event keys continue to
deduplicate prior records. Total cost remains exact; account-specific
attribution is explicitly uncertain until propagation completes.

## Scope

Version one supports macOS OAuth subscriptions with Claude Code 2.1.220 or
newer. It excludes API-key accounts, remote OAuth revocation, capacity/reset
data, CLI commands, Linux/Windows account management, account epochs, session
forking, and automatic exit/resume. If live validation proves hot propagation
unreliable, exit/resume is a separate follow-up using the existing Claude TUI
`--resume` UUID and ACP `session/load` contracts.
