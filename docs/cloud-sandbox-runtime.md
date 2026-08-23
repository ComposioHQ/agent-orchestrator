# Cloud sandbox runtime launch contract

`ao-sandbox` is disposable compute. It owns one direct PTY, an authenticated
published listener, the sole `ports.WorkspaceObservation` implementation for
bounded snapshot/list/read/watch/diff/blob access, and ephemeral secret
files. It does not run the AO daemon, SQLite, a cloud relay, durable product
state, or a sandbox-provider adapter.

## Daytona launch contract

The image in `deploy/sandbox/Dockerfile` installs the binary at
`/usr/local/bin/ao-sandbox`. Its builder and runtime image are pinned to the
same immutable digest; build it from the repository root with:

```sh
docker build --platform=linux/amd64 -f deploy/sandbox/Dockerfile .
```

Before launch, the provisioner writes the raw opaque sandbox capability to the
fixed path `/run/ao/capability`. It must be a regular file, mode `0600`, and
between 1 byte and 4 KiB. It is not JSON and has no trailing newline. The
sandbox reads it again for every redemption request, so capability rotation is
immediate and no secret is cached in launch configuration.

The control-plane base URL must be HTTPS. The runtime always redeems at
`POST /api/cloud/v1/sandbox/terminal-tickets/consume`; that atomic operation
returns a grant bound to the sandbox, workspace, and session IDs, an expiry,
and only the requested scopes. The sandbox has no signing key, offline
verifier, or local replay authority.

Launch with no secret values in argv or environment:

```sh
/usr/local/bin/ao-sandbox \
  --listen 0.0.0.0:8080 \
  --control-plane-url https://control.example \
  --sandbox-id provider-sandbox-id \
  --workspace-id control-plane-workspace-id \
  --session-id control-plane-session-id \
  --workspace /workspace \
  --ready-file /run/ao/ready.json \
  --secret-dir /run/ao/secrets \
  --route-prefix /api/sandbox/v1 \
  -- /usr/local/bin/the-agent fixed non-secret arguments
```

The child receives a fixed allowlisted environment (`HOME`, `LANG`, `PATH`,
and `TERM`) rather than the bootstrap process environment. Provider credentials
must be delivered as bytes through the neutral `secretfile.Sink.Deliver` with
mode `0600`, at the provider's expected file location or a non-secret file-path
setting. Never place credential bytes in command arguments, environment,
provider metadata, or logs.

## Listener and readiness

- Published TCP port: `8080`.
- Terminal WebSocket: `/mux`, subprotocol `ao.mux.v1`, with the ticket carried
  only as the `ao.ticket.<opaque>` subprotocol from `muxproto.Offer`.
- Workspace observation: `GET /api/sandbox/v1/workspace/observation`, with a
  one-time `X-AO-Ticket` carrying `workspace:observe`.
- Readiness probe: `GET /readyz`.
- Readiness signal file: `/run/ao/ready.json`, atomically published as
  `0600` only after the PTY and listener are live. It records the bound address,
  session ID, `/mux`, and the RPC route prefix.

Every non-empty WebSocket `Origin` is rejected. `Authorization: Bearer` is not
an authentication fallback. Terminal grants require `terminal:read`; PTY input
and resize additionally require `terminal:operate`. Normal TLS verification is
mandatory between the sandbox and control plane.

## Shutdown and cleanup

SIGTERM/SIGINT, listener failure, or PTY exit starts bounded shutdown. The
listener stops accepting, the PTY receives SIGTERM and then a bounded kill if
needed, all files registered with `FileSecret` are purged, and both the
capability and readiness files are removed. No replay or durable state is left
inside the sandbox; provider teardown remains responsible for deleting the
disposable workspace and sandbox.

## Staging acceptance

After the control plane launches a real sandbox whose PTY command is an
interactive shell, issue a single-use terminal ticket and run:

```sh
AO_SANDBOX_URL=wss://published-sandbox.example \
AO_SANDBOX_TICKET=opaque-one-time-ticket \
AO_SANDBOX_SESSION_ID=uuid \
go test ./backend/e2e -run TestSandboxRuntimeStaging -count=1 -v
```

The harness upgrades without an Origin header, opens the session terminal,
writes a unique marker through the PTY, and requires that marker to return over
the mux data frame. Reusing the ticket after this run must fail.
