# 3. Persistent provider hosts for Chat sessions

Date: 2026-08-26
Status: Accepted (Codex slice implemented; ACP bindings follow)

## Context

Chat controllers historically spawned a provider process (`codex app-server` or
an ACP adapter) as a child of the daemon. Desktop close, full quit, and updater
restart all stop that daemon. `Chat.Service.StopAll` therefore closed every
provider pipe, interrupted any active generation, and the replacement daemon had
to launch a new provider process and invoke native resume. The durable thread was
preserved, but the process and in-flight turn were not. TUI sessions did not have
this failure because tmux/conpty already owns their harness outside the daemon.

## Decision

AO will move native Chat provider process ownership into a detached, per-session
host. The daemon is an authenticated, exclusive client of that host, not its
parent lifetime owner.

The first production slice applies to Codex app-server:

- `ao chat-host` launches the provider in the session worktree and listens only
  on an ephemeral loopback TCP port. A 256-bit capability and protocol version
  live in a mode-0600 descriptor below `~/.ao/data/chat-hosts/<session>/`.
- Exactly one controller may attach. The host retains provider stdin/stdout when
  that client disconnects, so an active turn continues. A replacement daemon
  authenticates, takes the exclusive attachment, and does not repeat
  `initialize` or `thread/resume`. If updater processes overlap, the replacement
  waits for the old attachment to release instead of launching a rival provider.
- Provider frames produced while detached are replayed in order from a bounded
  32 MiB buffer. At the bound, the host applies backpressure instead of silently
  losing protocol output. Unanswered provider-to-client requests are retained
  even if a previous daemon received them, then replayed until a controller
  response is forwarded, so an approval cannot disappear across detach. Codex
  native history remains the repair source after host/provider failure.
- The host records the greatest numeric client request id it forwarded. A new
  controller starts above that high-water mark, preventing a late provider
  response from correlating with a replacement request.
- Controller-generation checks in SQLite remain the projection fence. The
  transport additionally rejects concurrent attachment, preventing two live
  daemon controllers from writing the provider connection.
- Normal daemon shutdown—including window-close supervisor shutdown, full app
  quit, and updater handoff—detaches. Explicit session kill, controller
  replacement, or durable orphan reconciliation sends authenticated shutdown.
- Deliberate detach does not project `ActivityExited`, settle the active turn, or
  fail pending input. A live reconnect also skips the native-history settled
  barrier; buffered protocol events continue the turn immediately on the same
  initialized connection.
- Startup orphan reconciliation only destroys a compatible host when durable
  state proves its Codex Chat session is terminated or absent. An unreadable
  store, incompatible descriptor, live PID with an unreachable endpoint, or
  failed auth is preserved rather than treated as death.
- Branch activation keeps its existing launch-before-destroy safety ordering. If
  the source controller still owns the exclusive host, its staged replacement
  uses a direct app-server; the next daemon reconciliation resumes that branch
  into a persistent host. This avoids breaking branch rollback but leaves a
  bounded migration gap: a daemon exit after branch activation and before the
  next reconciliation uses native resume rather than live reconnect.

The host inherits the already-resolved provider environment once at launch; no
credentials are written to its descriptor. Possession of the descriptor
capability grants control, so its directory and file permissions are part of the
security boundary. The daemon never exposes this transport through its HTTP API.

## Compatibility and update handoff

The descriptor protocol is explicitly versioned. A new daemon attaches only to
the exact supported version and leaves an incompatible live host untouched. This
fails closed—without spawning a competing provider—until an explicit compatible
handoff or session termination occurs. Provider protocol compatibility is
inherited from the already-running binary because reconnect does not relaunch or
renegotiate it.

Future host versions should add a sequence-numbered, disk-backed replay journal
with daemon acknowledgements before the detached window or provider protocol
requires more than the bounded Codex-first bridge. ACP drivers should reuse this
host transport after their request-id and initialization/resume semantics are
made explicit; they continue to use process restart plus native resume until
then.

## Consequences

- Closing/updating AO no longer terminates a Codex Chat harness or interrupts its
  active generation. Reopen latency loses provider launch, initialization, and
  native resume; it retains daemon reconciliation and native-history repair.
- The detached host is a new local process and capability-bearing control plane
  that must remain backwards-compatible across desktop updates.
- TUI lifecycle is unchanged: tmux/conpty remains its external owner. Non-Codex
  Chat bindings are unchanged in this slice and remain a known migration gap.
- Host crashes still require ordinary native resume. In-memory replay protects
  daemon replacement, not host or machine failure.
