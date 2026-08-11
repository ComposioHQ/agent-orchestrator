# 2. Remote workspaces: one daemon per machine, reached over an SSH port-forward

Date: 2026-08-11
Status: Proposed

## Context

A common way to work is a thin laptop and a fat VM: the compute, the checkouts,
the credentials and the automations all live on the VM, and the laptop is where
you sit. Today AO has no answer for that. The desktop app spawns a daemon on the
machine it runs on, and every session runs there. Discussion #2855 is an
unanswered user asking to point the desktop app at a remote daemon; issue #13
listed "Remote session support (SSH + tmux on remote machines)" and was closed
as rewrite-migration cleanup with an invitation to refile.

Two shapes were considered.

**A. One laptop daemon that places individual sessions on a VM over SSH.** The
control plane stays local; a session gains a placement, and the local daemon
shells out to run tmux and the agent on the far side.

**B. One daemon per machine; the client connects to whichever one it is pointed
at.** The VM runs an ordinary, unmodified AO daemon against its own filesystem.

Shape A was designed in full first, and the design is what argued against it.
Because every consumer that addresses a live session holds nothing but a
`ports.RuntimeHandle{ID string}`, routing has to be a pure function of that
string, which forces the host to be encoded into the handle id — and the id
space is mintable by project names, so a folder can forge a remote handle and
get a healthy session reaped. Beyond that, `gitworktree` bypasses its own
command runner in ten places (so it cannot be remoted by swapping the runner),
`binaryutil.LookPath` resolves agent binaries to *laptop* absolute paths that
then land in the remote pane's `argv[0]`, hooks and the system-prompt file are
written to the local filesystem at the remote path, and `AO_BROWSER_CAPABILITY`
— a live capability token — sits in the environment that would be exported to a
third machine. Each is solvable; together they are a large, permanently
load-bearing surface, and every one of them exists only because a single daemon
is trying to act on a filesystem that is not its own.

Shape B has none of those problems, because on the far side nothing is remote:
the daemon, the git worktrees, the tmux server, the agent binary and the hooks
are all local to each other. What it needs instead is a transport, and a client
that can hold more than one daemon endpoint.

## Decision

**A workspace is a machine that runs its own AO daemon.** The laptop is the
`local` workspace. A remote workspace is an SSH target the desktop app reaches
through a loopback port-forward.

The decisive detail is that this needs almost no client change either. The
renderer already addresses the daemon through a single mutable base URL that the
supervisor hands it on the `daemon:status` channel, and the terminal-mux
WebSocket and SSE stream both derive from that base. So the supervisor opens

```
ssh -N -L <freeLocalPort>:127.0.0.1:<remoteDaemonPort> <target>
```

and publishes `<freeLocalPort>` as the daemon port. Every existing renderer
feature — the board, sessions, diffs, terminals — then runs against the remote
daemon unmodified.

### Consequences for the bind rule

**Neither daemon's bind changes, and no new listener is added.** This is the
central reason to prefer the forward over widening the daemon's bind: the remote
daemon stays `127.0.0.1`-only, so it is reachable only by processes on the VM
and by whoever can already open an authenticated SSH session to it. AGENTS.md's
loopback-only hard rule holds on both machines, and unlike ADR-0001 this feature
needs no exception to it.

Authentication is SSH's, not AO's. AO persists no key material and writes no
`known_hosts`; it shells out to the user's own `ssh`, for the same reason
`docs/stack.md` shells out to `git` rather than embedding go-git — `~/.ssh/config`
(ProxyJump, Match, Include, IdentityAgent) is the identical artifact class, and
reimplementing it is the go-git mistake.

### Security posture

- **`BatchMode=yes` is load-bearing, not hygiene.** The supervisor has no
  controlling tty, so it can answer neither a passphrase prompt nor the
  interactive "Are you sure you want to continue connecting?" for an unknown
  host key. BatchMode turns both into an immediate, classifiable failure instead
  of a process that hangs forever.
- **`StrictHostKeyChecking` is deliberately never set.** BatchMode already makes
  an unknown key fail closed. Setting it to `no` or `accept-new` is exactly the
  bypass this design refuses: an unknown host is surfaced to the user with the
  instruction to connect once themselves and see the fingerprint, and a *changed*
  host key is reported as the security event it is. AO never edits
  `known_hosts`.
- **The ControlMaster socket is a credential.** It is a persistent, always-warm,
  authenticated remote-shell channel that AO creates and keeps alive. `0700` on
  `~/.ao/ssh` is the entire access control and `ControlPersist=60` is the
  exposure window after last use. Accepted: it is the same trust the user's own
  shell already holds, and without multiplexing every status poll pays a full
  TCP and auth handshake.
- **AO never installs anything on the remote.** A host without `ao` is reported
  with the command to run. Executing package installs across a fleet of machines
  the maintainers do not own would make AO a configuration-management tool; the
  local analogue (a missing tmux) is likewise a hard preflight failure, not an
  install.
- **The registry holds no secrets.** An entry is an id and an SSH target — a
  hostname, or better an alias from the user's own `~/.ssh/config`.

### What lives where

`~/.ao/workspaces.json` is supervisor state, not daemon state: it names which
daemons the client can reach, so requiring the machine it points at to be up in
order to read it would be circular. Each daemon keeps its own `~/.ao` on its own
machine, which reads AGENTS.md's `~/.ao` rule as "local state under the local
`~/.ao`" — the rule is about never using OS-default app-data locations, and that
holds unchanged on both ends.

### Failure semantics

OpenSSH exits **255 for its own failures** and otherwise forwards the remote
command's status, so a bare non-zero exit cannot be attributed to a side. AO
classifies that split explicitly, because a broken tunnel reported as a dead
daemon would violate the hard rule that a failed probe is not proof a session
died. A dropped tunnel leaves the remote daemon and its tmux sessions running
untouched, so the client holds the session in a reconnecting state and re-dials
rather than tearing anything down.

## Alternatives rejected

- **Widen the daemon's bind to the LAN or the VM's public interface.** This is
  the obvious reading of "connect the app to a remote daemon" and it is the one
  thing the codebase forbids by design. It would also require AO to own
  authentication and transport security for a full remote-control API — far
  beyond ADR-0001's home-network, opt-in, single-password posture.
- **Session placement (shape A).** Deferred, not refuted. It is the better
  answer to "run *this one task* on the big machine while I keep working
  locally", and it can be layered on later. It is the wrong first step, because
  it pays the entire remote-filesystem cost before delivering the ordinary case.
- **An AO-specific agent daemon on the VM.** The VM already runs the daemon we
  want; adding a second AO-authored service to supervise it is unnecessary.
- **`golang.org/x/crypto/ssh` in-process.** Forces AO to own key material,
  passphrase prompting with no UI to prompt from, agent forwarding, and a
  `known_hosts` TOFU policy. AO persists exactly one secret today (ADR-0001's
  rotating LAN password) and does not persist GitHub tokens at all. Shelling out
  also gets resize and SIGWINCH propagation for free.

## Status of the implementation

Landed: the registry, the SSH transport and failure taxonomy, supervisor
placement and re-dial, and the workspace switcher in settings.

Not yet addressed:

- Moving an existing session between workspaces. Placement is chosen per client,
  and sessions belong to the daemon that spawned them.
- A cross-workspace view. Only the selected workspace's board is shown.
- `ao` CLI parity: the CLI still talks to the local daemon only.
- Windows as the client. The failure path is graceful (a missing `ssh` is
  reported as such), but it is untested.
