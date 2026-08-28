# OMP Adapter

OMP is integrated into Agent Orchestrator as an interactive Terminal UI
harness. AO launches the `omp` binary inside the session worktree and streams
the TUI through the existing terminal runtime.

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
- `--extension <workspace>/.omp/extensions/ao-activity.ts` so OMP reports
  TUI activity through `ao hooks omp`

The process remains interactive after the initial prompt, so users can keep
working directly in the OMP TUI.

## Activity

AO installs a workspace-local TypeScript extension and passes it explicitly
with `--extension`. The extension maps OMP lifecycle events onto AO activity:

| OMP event | AO hook | Activity |
| --- | --- | --- |
| `session_start` | `session-start` | idle |
| `before_agent_start` | `user-prompt-submit` | active |
| `session_stop` | `stop` | idle |
| `session_shutdown` | `session-end` | exited |

`session_start` is idle because OMP emits it before any prompt starts. The
active transition comes from `before_agent_start`. OMP has no `agent_settled`
event; `session_stop` is the settle signal that a main-agent turn is about to
go idle. Launch and restore pass `--extension` so reporting does not depend
on project-local extension auto-discovery. Chat-mode activity is unchanged.

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

## Not Supported In This Adapter

- ACP editor integration (`omp acp`)
- RPC mode (`omp --mode rpc`)
- Chat UI handoff

Those surfaces would require a separate structured protocol driver rather than
the terminal harness adapter. The TUI activity extension above is installed
and loaded by this adapter; it is not a Chat/ACP driver.
