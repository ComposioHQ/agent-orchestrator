# OMP Adapter

OMP is integrated into Agent Orchestrator as both an interactive Terminal UI
harness and a structured Chat harness. AO launches the user's own `omp` binary
inside the session worktree in either mode.

## Install

Install OMP using one of its supported upstream installers, then make sure the
`omp` binary is available on `PATH`.

Common install paths include:

```bash
curl -fsSL https://omp.sh/install | sh
brew install can1357/tap/omp
bun install -g @oh-my-pi/pi-coding-agent
```

Verify the install:

```bash
omp --version
```

AO resolves `omp` from:

- `PATH`
- `/usr/local/bin/omp`, `/opt/homebrew/bin/omp`
- Node-managed global bin directories
- `~/.omp/bin/omp`
- `%AppData%\npm\omp.cmd` and `%AppData%\npm\omp.exe` on Windows

## Supported AO Mode

OMP is exposed through AO's Terminal UI mode. A fresh prompted session launches
as:

```bash
omp "<prompt>"
```

When configured, AO forwards:

- `--model <model>` from the agent config model field
- `--append-system-prompt <text>` for AO's role/system prompt

The process remains interactive after the initial prompt, so users can keep
working directly in the OMP TUI.

## Activity Tracking

AO installs one managed extension at `.omp/extensions/ao-activity.ts` inside
the session worktree and passes it explicitly with `--extension` on launches
and restores. The extension reports OMP's native session, agent, and approval
lifecycle through AO's existing hook pipeline:

- session startup and turn completion report `idle`
- prompt submission reports `active`
- approval requests report `waiting_input`
- approval resolution reports `active`
- process shutdown reports `exited`

Hook delivery is best-effort. A missing AO executable, an unavailable daemon,
or a hook timeout never interrupts the OMP session. AO refuses to overwrite a
user-owned file at the managed extension path and preserves all other OMP
extensions.

## Chat Mode

OMP 15.0.0 and newer can run through its native `omp acp` command in AO's Chat
interface. Chat activity is derived directly from structured turn, approval,
input, and controller events rather than from the TUI extension.

## Restore

When AO has captured an OMP native session id in session metadata, restore uses:

```bash
omp --resume <native-session-id>
```

If no native session id is available, AO falls back to a fresh interactive
launch.

## Auth

AO checks OMP auth using local-only signals:

1. `PI_CODING_AGENT_DIR/auth.json`, when `PI_CODING_AGENT_DIR` is set.
2. `~/.omp/agent/auth.json`, when present.
3. Cheap CLI auth/status probes, such as `omp auth status`.

These probes are advisory. A later model call can still fail because of quota,
provider configuration, or selected model availability.

## Not Supported

- RPC mode (`omp --mode rpc`)
- TUI-to-Chat or Chat-to-TUI handoff of an existing OMP session
