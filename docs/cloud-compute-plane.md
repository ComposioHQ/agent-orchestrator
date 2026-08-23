# Cloud compute plane

AO Cloud places each workspace coordinator and each worker session in a
separate disposable sandbox. PostgreSQL remains the durable authority; a
sandbox contains only a checkout, caches, transient capability files, and live
processes.

## Boundaries

- `backend/internal/ports.ComputeProvider` is the provider-neutral lifecycle
  port. `internal/cloud/runtime/daytona` is the Daytona adapter.
- A placement row is inserted before provider creation. Stable labels bind the
  provider sandbox to deployment, organization, workspace, session, role, and
  runtime row. A lost create response is therefore reclaimable.
- Create, start, stop, and delete are idempotent. Delete revokes scoped access,
  releases published routes, purges launch credentials, deletes provider
  compute, and only then removes the durable placement row.
- The reaper converges desired and provider state, stops idle placements,
  deletes abandoned or stuck placements, and removes labelled orphans. It may
  delete unattributed sandboxes only when the provider account is dedicated to
  that deployment and the explicit opt-in is enabled.
- Provider auto-stop and auto-delete intervals are mandatory. They cap spend
  even while the control plane or its reaper is unavailable.

## Launch and secret contract

The provider must execute `CreateRequest.Command` and `CreateRequest.Args` as
semantic argv, not ignore them or reinterpret arguments as trusted shell text.
Daytona exposes a string command API, so the adapter POSIX-quotes every argv
element, prefixes `exec`, and runs it asynchronously in a stable process
session. A retry observes the existing session and does not launch a duplicate.

No credential is allowed in process arguments, environment variables, URLs,
provider labels, or logs. The provider writes the exact 181 launch metadata to
`/run/ao-sandbox/capability.json` as a transient byte buffer with mode `0600`:
provider sandbox id, workspace id, session id, and the HTTPS online-redemption
URL. Other launch credentials also use `FileSecret` byte buffers. The provider
overwrites every buffer on success and failure. Opaque operation tickets are
issued to clients and redeemed atomically online; they are not launch bearers
and no signing key or replay database enters the sandbox.

The adapter starts `/usr/local/bin/ao-sandbox` with fixed listener, workspace,
readiness, secret-directory, and route-prefix flags. `CreateRequest.Command`
and `Args` follow `--` as the semantic PTY child argv. Readiness is published at
`/run/ao-sandbox/ready.json`; the terminal mux is `/mux`.

The published sandbox endpoint is a separate authenticated listener owned by
the thin sandbox runtime. Do not publish the local daemon listener, accept a
shared bearer fallback, disable TLS verification, or relax origin checks.
Terminal mux and readiness routes must remain bound to the placement's scoped
capability.

## Configuration

Compute is off unless `AO_CLOUD_COMPUTE_ENABLED=true`. Required settings:

```text
AO_CLOUD_DEPLOYMENT
AO_CLOUD_PUBLIC_URL
AO_CLOUD_DAYTONA_API_KEY_FILE
AO_CLOUD_COORDINATOR_SNAPSHOT
AO_CLOUD_WORKER_SNAPSHOT
```

`AO_CLOUD_PUBLIC_URL` must use HTTPS. The
Daytona API key file must be readable only by its owner. Prefer a secret-manager
file mount; do not put the key in a unit file's command, shell history, test
output, or CI log.

Useful optional settings:

```text
AO_CLOUD_DAYTONA_API_URL
AO_CLOUD_DAYTONA_ORGANIZATION_ID
AO_CLOUD_DAYTONA_TARGET
AO_CLOUD_SANDBOX_CPU
AO_CLOUD_SANDBOX_MEMORY_GB
AO_CLOUD_SANDBOX_DISK_GB
AO_CLOUD_SANDBOX_AUTO_STOP
AO_CLOUD_SANDBOX_AUTO_DELETE
AO_CLOUD_MAX_SANDBOXES_PER_ORG
AO_CLOUD_MAX_SANDBOXES_PER_USER
AO_CLOUD_MAX_WORKERS_PER_WORKSPACE
AO_CLOUD_MAX_COORDINATORS_PER_WORKSPACE
AO_CLOUD_REAPER_INTERVAL
AO_CLOUD_SANDBOX_IDLE_TIMEOUT
AO_CLOUD_SANDBOX_ABANDONED_TIMEOUT
AO_CLOUD_SANDBOX_PROVISIONING_TIMEOUT
AO_CLOUD_SANDBOX_ORPHAN_GRACE
```

## Verification

Run the deterministic provider and lifecycle suites first:

```bash
cd backend
go test ./internal/cloud/runtime/...
go test -race ./internal/cloud/runtime/...
```

The opt-in Daytona staging test creates billable compute and deletes it in a
cleanup hook. Use a dedicated staging provider account and owner-only temporary
key file:

```bash
cd backend
AO_CLOUD_DAYTONA_API_KEY_FILE=/run/secrets/daytona-staging \
AO_CLOUD_WORKER_SNAPSHOT=ao-worker-staging \
AO_CLOUD_DAYTONA_ORGANIZATION_ID=staging-provider-org \
AO_CLOUD_DAYTONA_TARGET=us \
go test -tags=integration ./internal/cloud/runtime/daytona -run TestStagingLifecycle -v
```

After the test, verify the provider console has no sandbox labelled
`ao.deployment=staging-acceptance`. Any survivor is a failed cleanup and must be
deleted before continuing.

The full integration acceptance, wired by the cloud composition layer, is:

1. Create a cloud project and confirm a durable coordinator placement row.
2. Confirm the coordinator sandbox becomes ready through its authenticated
   published endpoint.
3. Create a worker session and confirm a distinct worker placement and sandbox.
4. Connect the terminal mux, run a command, resize it, disconnect, and resume
   from the bounded cursor.
5. Delete the session and project, then confirm routes and capabilities are
   revoked, provider sandboxes are absent, and placement rows are gone.
6. Run one reconciliation pass and confirm there are no labelled orphans,
   unattributed leaks, or retained launch-ticket files.
