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
- Provider-only orphan/leak deletion is capped per pass by a mass-delete
  breaker. Candidates over the cap are reported and deferred.

## PostgreSQL handoff (migration window 00020-00029)

The compute package does not register tables itself. The cloud integrator must
allocate migrations in the shared `00020`-`00029` window and wire adapters for
the three ports in `backend/internal/ports/compute.go`. The existing
`ao_cloud_session_runtimes` table is the placement authority and is already in
the canonical `runtimeTables` registry. Extend it rather than creating a
second placement table. The minimum migration delta is:

```sql
ALTER TABLE ao_cloud_session_runtimes
  ADD COLUMN user_id uuid REFERENCES ao_users(id),
  ADD COLUMN role text NOT NULL DEFAULT 'worker'
    CHECK (role IN ('coordinator', 'worker')),
  ADD COLUMN desired_state text NOT NULL DEFAULT 'running'
    CHECK (desired_state IN ('running', 'stopped', 'deleting')),
  ADD COLUMN last_heartbeat_at timestamptz;
UPDATE ao_cloud_session_runtimes runtime
SET user_id = workspace.owner_user_id
FROM ao_cloud_workspaces workspace
WHERE workspace.id = runtime.workspace_id;
ALTER TABLE ao_cloud_session_runtimes
  ALTER COLUMN user_id SET NOT NULL,
  DROP CONSTRAINT ao_cloud_session_runtimes_state_check,
  ADD CONSTRAINT ao_cloud_session_runtimes_state_check CHECK (state IN
    ('provisioning', 'running', 'stopped', 'failed', 'deleting')),
  ADD CONSTRAINT ao_cloud_session_runtimes_generation_check
    CHECK (generation > 0);
CREATE UNIQUE INDEX ao_cloud_session_runtimes_provider_id_uq
  ON ao_cloud_session_runtimes (sandbox_id) WHERE sandbox_id <> '';
CREATE INDEX ao_cloud_session_runtimes_reaper_idx
  ON ao_cloud_session_runtimes (state, updated_at);
CREATE INDEX ao_cloud_session_runtimes_user_quota_idx
  ON ao_cloud_session_runtimes (user_id) WHERE state <> 'deleting';

CREATE TABLE ao_cloud_capability_grants (
  id text PRIMARY KEY,
  verifier text NOT NULL,                      -- one-way digest, never bearer
  org_id uuid NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES ao_cloud_workspaces(id) ON DELETE CASCADE,
  session_id text,
  role text NOT NULL CHECK (role IN ('coordinator', 'worker')),
  operations text[] NOT NULL CHECK (cardinality(operations) > 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_to_id text REFERENCES ao_cloud_capability_grants(id)
);
CREATE INDEX ao_cloud_capability_grants_scope_idx
  ON ao_cloud_capability_grants (org_id, workspace_id, session_id)
  WHERE revoked_at IS NULL;
CREATE INDEX ao_cloud_capability_grants_expiry_idx
  ON ao_cloud_capability_grants (expires_at, revoked_at);
ALTER TABLE ao_cloud_capability_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_cloud_capability_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_cloud_capability_grants_workspace
  ON ao_cloud_capability_grants FOR ALL
  USING (
    workspace_id = ao_current_workspace_id()
    AND org_id = ao_current_org_id()
    AND ao_is_org_member(org_id, ao_current_user_id())
    AND EXISTS (
      SELECT 1 FROM ao_cloud_workspaces workspace
      WHERE workspace.id = ao_cloud_capability_grants.workspace_id
        AND workspace.org_id = ao_cloud_capability_grants.org_id
        AND workspace.owner_user_id = ao_current_user_id()
    )
  )
  WITH CHECK (
    workspace_id = ao_current_workspace_id()
    AND org_id = ao_current_org_id()
    AND ao_is_org_member(org_id, ao_current_user_id())
    AND EXISTS (
      SELECT 1 FROM ao_cloud_workspaces workspace
      WHERE workspace.id = ao_cloud_capability_grants.workspace_id
        AND workspace.org_id = ao_cloud_capability_grants.org_id
        AND workspace.owner_user_id = ao_current_user_id()
    )
  );
REVOKE ALL ON TABLE ao_cloud_capability_grants FROM PUBLIC;

CREATE TABLE ao_cloud_terminal_tickets (
  id text PRIMARY KEY,
  verifier bytea NOT NULL UNIQUE,               -- SHA-256-sized digest
  org_id uuid NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES ao_cloud_workspaces(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  sandbox_id uuid NOT NULL REFERENCES ao_cloud_session_runtimes(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('coordinator', 'worker')),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (octet_length(verifier) = 32)
);
CREATE INDEX ao_cloud_terminal_tickets_scope_idx
  ON ao_cloud_terminal_tickets (org_id, workspace_id, session_id, sandbox_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX ao_cloud_terminal_tickets_expiry_idx
  ON ao_cloud_terminal_tickets (expires_at, consumed_at, revoked_at);
ALTER TABLE ao_cloud_terminal_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_cloud_terminal_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY ao_cloud_terminal_tickets_workspace
  ON ao_cloud_terminal_tickets FOR ALL
  USING (
    workspace_id = ao_current_workspace_id()
    AND org_id = ao_current_org_id()
    AND ao_is_org_member(org_id, ao_current_user_id())
    AND EXISTS (
      SELECT 1 FROM ao_cloud_workspaces workspace
      WHERE workspace.id = ao_cloud_terminal_tickets.workspace_id
        AND workspace.org_id = ao_cloud_terminal_tickets.org_id
        AND workspace.owner_user_id = ao_current_user_id()
    )
  )
  WITH CHECK (
    workspace_id = ao_current_workspace_id()
    AND org_id = ao_current_org_id()
    AND ao_is_org_member(org_id, ao_current_user_id())
    AND EXISTS (
      SELECT 1 FROM ao_cloud_workspaces workspace
      WHERE workspace.id = ao_cloud_terminal_tickets.workspace_id
        AND workspace.org_id = ao_cloud_terminal_tickets.org_id
        AND workspace.owner_user_id = ao_current_user_id()
    )
  );
REVOKE ALL ON TABLE ao_cloud_terminal_tickets FROM PUBLIC;
```

Append exactly `ao_cloud_capability_grants` and
`ao_cloud_terminal_tickets` to `runtimeTables`; `ao_cloud_session_runtimes` is
already present. No compute-specific function needs an `EXECUTE` grant: quota
reservation, generation CAS, revocation, and one-time ticket consumption use
ordinary tenant-scoped transactions and `UPDATE ... RETURNING` through the
restricted runtime role, not `SECURITY DEFINER` helpers.

The placement adapter must implement `Ensure` as a single quota reservation
transaction. Acquire transaction advisory locks in the fixed order org, user,
workspace/role (for example `pg_advisory_xact_lock(hashtextextended(key, 0))`),
re-read the unique placement, count rows whose state is not `deleting`, enforce
all configured limits, then insert `provisioning`. Competing requests must not
both observe `limit - 1`. `Save` is exactly `UPDATE ... SET generation =
generation + 1 ... WHERE id = $id AND generation = $generation RETURNING ...`;
zero rows is `ErrConflict`. `Delete` uses the same generation predicate,
succeeds if the row is already absent, and must never turn `deleting` back into
a live state. Adapter tests must invoke `runtimetest.RunStoreConformance`.

Capability revocation is an idempotent durable update that preserves the first
`revoked_at`; scope revocation happens before secrets, routes, or provider
compute are removed. A terminal ticket consume transaction selects the digest
and exact org/workspace/session/sandbox-handle/role scope `FOR UPDATE`, rejects
expired/revoked/consumed rows, and sets `consumed_at` before returning. This
lock/update is the replay boundary: exactly one concurrent consumer succeeds.
Unknown verifier and scope mismatch both map to `ErrTicketNotFound`; known spent,
expired, and revoked rows map to their specific errors. PostgreSQL adapter tests
must invoke `storetest.RunCapabilityConformance` and
`storetest.RunTerminalTicketConformance`. Neither table stores a
plaintext bearer, signing key, or reusable launch credential.

## Launch and secret contract

The provider must execute `CreateRequest.Command` and `CreateRequest.Args` as
semantic argv, not ignore them or reinterpret arguments as trusted shell text.
Daytona exposes a string command API, so the adapter POSIX-quotes every argv
element, prefixes `exec`, and runs it asynchronously in a stable process
session. A retry observes the existing session and does not launch a duplicate.

No credential is allowed in process arguments, environment variables, URLs,
provider labels, or logs. The control plane issues a fresh opaque sandbox
capability backed by the durable verifier store. The provider delivers its raw
bytes to the exact 181 path `/run/ao/capability` with mode `0600`; Start revokes
the preceding scope and overwrites the file with a newly issued capability.
The durable runtime row id (the public sandbox handle), workspace id, and
session id plus the verified HTTPS control-plane base URL are non-secret
`ao-sandbox` flags. The provider id remains private to the placement row. Other
launch credentials also use `FileSecret` byte buffers. The provider overwrites
every buffer on success and failure. Opaque terminal tickets are issued to clients and redeemed
atomically online; they are separate from the rotating sandbox capability and
no signing key or replay database enters the sandbox.

The adapter starts `/usr/local/bin/ao-sandbox` with fixed listener, workspace,
readiness, secret-directory, and route-prefix flags. `CreateRequest.Command`
and `Args` follow `--` as the semantic PTY child argv. Readiness is published at
`/run/ao/ready.json`; the secret sink root is `/run/ao/secrets`, and the
terminal mux is `/mux`.

The exact 181 CLI contract is `--listen 0.0.0.0:8080`,
`--control-plane-url <absolute HTTPS base>`, `--sandbox-id <runtime row id>`,
`--workspace-id`, `--session-id`, `--workspace /workspace`,
`--ready-file /run/ao/ready.json`, `--secret-dir /run/ao/secrets`, and
`--route-prefix /api/sandbox/v1`, followed by `--` and the absolute child
executable plus its semantic arguments. There is deliberately no
`--capability` or `--capability-file` option: the runtime always reads the
owner-only regular file `/run/ao/capability` afresh for each redemption.
The readiness file is atomically installed with mode `0600` and contains only
`address`, `muxPath`, `routePrefix`, and `sessionId`; `muxPath` is `/mux`.
Runtime shutdown removes both the readiness and capability files and purges
the secret sink.

The published sandbox endpoint is a separate authenticated listener owned by
the thin sandbox runtime. Do not publish the local daemon listener, accept a
shared bearer fallback, disable TLS verification, or relax origin checks.
Terminal mux and workspace observation require scoped one-time tickets;
readiness exposes no tenant data. The rotating sandbox capability is used only
for the runtime's authenticated outbound ticket-redemption request.

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
AO_CLOUD_MAX_PROVIDER_DELETES_PER_RUN
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

This repository's deterministic tests validate request shape and lifecycle
semantics, but do not prove Daytona's current staging contract. Before calling
the integration complete, 140 must verify against the real staging account:
the create and transition paths, toolbox file upload/permission and process
session endpoints, the `createdAt` format and meaning, label filtering,
idempotency headers, provider auto-stop/auto-delete units, and whether async
commands preserve the quoted semantic argv. Record any API mismatch as an
adapter change; do not waive it based on the fake provider.

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
