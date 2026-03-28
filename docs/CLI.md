# AO CLI Reference

The `ao` CLI is the control interface for Agent Orchestrator. Most commands are used by the **orchestrator agent itself** to manage sessions, not by humans directly. Humans typically only need `ao start` and the web dashboard.

## Commands humans use

```bash
ao start                               # Auto-detect, generate config, start dashboard + orchestrator
ao start <url>                         # Clone repo, auto-configure, and start
ao start ~/other-repo                  # Add a new project and start
ao stop                                # Stop everything (dashboard, orchestrator, lifecycle worker)
ao status                              # Overview of all sessions
ao status --watch                      # Live-updating terminal status view
ao dashboard                           # Open web dashboard in browser
```

## Commands the orchestrator agent uses

These are primarily invoked by the orchestrator agent running inside a tmux session. You can use them manually if needed, but the orchestrator handles this automatically.

```bash
ao spawn [issue]                       # Spawn an agent (project auto-detected from cwd)
ao spawn 123 --agent codex             # Override agent for this session
ao spawn 123 --runtime docker --runtime-image ghcr.io/composio/ao:latest
ao batch-spawn 101 102 103             # Spawn agents for multiple issues at once
ao send <session> "Fix the tests"      # Send instructions to a running agent
ao session ls                          # List sessions
ao session kill <session>              # Kill a session
ao session restore <session>           # Revive a crashed agent
```

## Maintenance commands

```bash
ao doctor                              # Check install, runtime, and stale temp issues
ao doctor --fix                        # Apply safe fixes automatically
ao update                              # Update local AO install (source installs only)
ao config-help                         # Show full config schema reference
```

`ao doctor` checks PATH and launcher resolution, required binaries, configured plugin resolution, tmux and GitHub CLI health, config support directories, stale AO temp files, and core build/runtime sanity. If your config enables `runtime: docker`, it also verifies Docker daemon access, checks that an image is configured, and warns about Linux rootless/GPU setup.

`ao update` fast-forwards the local install on `main`, reinstalls dependencies, clean-rebuilds core packages, refreshes the launcher, and runs smoke tests. Use `ao update --skip-smoke` to stop after rebuild, or `ao update --smoke-only` to rerun just the smoke checks.

## Runtime override examples

```bash
ao start --runtime docker --runtime-image ghcr.io/composio/ao:latest
ao start --runtime docker --runtime-memory 4g --runtime-cpus 2 --runtime-read-only
ao spawn 123 --runtime docker --runtime-network bridge --runtime-cap-drop ALL
ao spawn 123 --runtime docker --runtime-read-only --runtime-tmpfs /tmp --runtime-cap-drop ALL --runtime-cap-drop NET_RAW
ao spawn 123 --runtime docker --runtime-config '{"limits":{"memory":"4g"}}'
```

Runtime override rules:

- Command-line runtime overrides merge on top of the project's configured `runtimeConfig`.
- `--runtime-config` is merged first, then explicit flags such as `--runtime-memory` or `--runtime-read-only` win for the same keys.
- `--runtime-cap-drop` and `--runtime-tmpfs` are repeatable.
- Runtime-aware attach surfaces (`ao session attach`, `ao open`, and the web dashboard terminal) use `docker exec ... tmux attach` for Docker sessions.
