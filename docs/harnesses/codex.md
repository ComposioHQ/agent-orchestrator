# Codex profiles

AO discovers the effective existing Codex profile and AO-managed profiles under
Settings → Agents. Browser sign-in is performed by Codex app-server. Codex owns
the credentials; AO does not parse credential files, copy native history, or
expose profile home paths.

Local Codex sessions have one immutable profile binding. A manual profile
continuation creates a related AO session on the same workspace and branch,
starts a fresh Codex thread under the selected profile, and archives the
predecessor only after the continuation acknowledges its handoff.

Automatic switching is an explicit, chain-scoped option in the bound-profile
section of session details. It is disabled by default. The user controls an
ordered allowlist of existing or AO-managed profiles. After structured Codex
signals or a lifecycle-bound capacity read freshly confirm exhaustion, AO checks
that list in order. Only a freshly authenticated profile whose direct capacity
read reports `available` may be selected. The current profile and near-limit,
exhausted, missing, signed-out, stale, unknown, or unsupported profiles are
skipped.

Automatic selection stops after the first eligible target and delegates that
one target to the same assisted-switch coordinator. That coordinator remains
the sole owner of safe-boundary waiting, handoff creation, source shutdown,
workspace transfer, target launch, acknowledgement, archive, and recovery.
There is no target cascade, global preference, terminal-output parsing,
capacity ranking, polling loop, or persisted provider quota data.
