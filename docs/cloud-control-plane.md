# Cloud control-plane foundation

This repository contains the first hosted AO control-plane slice: a small Go
service backed by PostgreSQL and Google identity, plus an AWS staging stack. The
slice is intentionally limited to authentication, tenancy, credential custody, and deployment. It
does **not** expose cloud projects or sessions yet.

That limit is architectural, not merely a feature flag. Cloud product state
must not live in a sandbox-local SQLite database. A sandbox is disposable
compute; PostgreSQL is the durable multi-device authority for hosted projects,
sessions, lifecycle facts, SCM observations, notifications, and chat state.
The cloud project/session UI will be enabled only after those existing AO
service boundaries are backed by a tenant-scoped PostgreSQL adapter.

## Included in this foundation

- `backend/cmd/ao-cloud`: liveness, readiness, Google identity exchange, AO
  session refresh/logout, and current-account routes.
- `backend/cmd/ao-cloud-migrate`: migration-only command using a separate
  privileged database connection.
- `backend/internal/cloud/auth`: Google OpenID Connect verification, short-lived
  AO JWT access tokens, and opaque refresh tokens.
- `backend/internal/cloud/postgres`: users, hashed refresh sessions,
  organizations, memberships, placement-schema groundwork, and forced RLS.
- `backend/internal/cloud/httpapi`: the implemented public auth/account surface.
- `backend/internal/cloud/credentials`: owner-scoped coding-harness credential
  custody using per-credential AWS KMS data keys and AES-256-GCM envelopes.
- `deploy/cloud`: a digest-pinned, least-privilege AWS staging deployment.

The local daemon remains loopback-only and continues to use SQLite. Electron
main owns Cloud identity and credential import; no credential material crosses
the preload bridge.

## HTTP surface

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | Process liveness |
| `GET /readyz` | none | PostgreSQL readiness |
| `POST /api/cloud/v1/auth/google` | Google ID token in JSON | Verify identity and issue an AO session |
| `POST /api/cloud/v1/auth/refresh` | Rotating refresh token in JSON | Atomically consume and replace a refresh token |
| `POST /api/cloud/v1/auth/logout` | Refresh token in JSON | Revoke a refresh token |
| `GET /api/cloud/v1/me` | AO bearer access token | Return the user and live organization memberships |
| `GET /api/cloud/v1/orgs/{orgId}/provider-connections` | AO bearer access token + membership | Return redacted credential status |
| `PUT /api/cloud/v1/orgs/{orgId}/provider-connections/agents/{provider}` | AO bearer access token + membership | Encrypt and rotate the caller's credential |
| `DELETE /api/cloud/v1/orgs/{orgId}/provider-connections/agents/{provider}` | AO bearer access token + membership | Revoke the caller's credential and delete its ciphertext |

Google establishes identity only. A verified Google hosted-domain claim never
creates, selects, or authorizes an AO organization. First sign-in atomically
creates the user, a personal organization, and its owner membership. The
required `AO_CLOUD_ALLOWED_EMAILS` gate is checked both at exchange and refresh.

Access tokens contain the AO user ID but no organization membership. Every
account read reloads memberships from PostgreSQL, so disabling a membership
takes effect without waiting for token expiry. Refresh tokens are opaque random
values and only their SHA-256 digests are stored. Rotation preserves the
original absolute expiry instead of extending a session indefinitely.

## Durable-state architecture

Local and cloud deployments share domain types, services, HTTP DTOs, and React
components. Only outbound implementations differ:

```text
Electron / typed API client
          |
          +-- local project --> loopback AO API --> services --> SQLite store
          |
          +-- cloud project --> hosted AO API  --> same services --> PostgreSQL store (RLS)
                                                    |
                                                    +--> compute/runtime adapter
                                                         --> isolated disposable sandbox
```

Rules for the cloud implementation:

1. PostgreSQL is the single durable authority. There is no SQLite/PostgreSQL
   replication, backup-on-stop protocol, or dual write.
2. The hosted API executes the same service layer and exposes the same product
   contract used by local AO. The renderer does not switch to a provider-
   specific API or fork project/session/terminal components.
3. Store interfaces are consumer-owned and narrow. SQLite and PostgreSQL adapt
   to those interfaces; domain and service packages do not import either
   database implementation.
4. Every cloud request carries a verified principal and selected organization.
   PostgreSQL transactions set both tenant contexts and RLS is forced on every
   tenant table. Explicit tenant predicates remain in queries as defense in
   depth.
5. Sandboxes contain a repository checkout, caches, and live runtime processes
   only. Losing or reaping one cannot lose projects, sessions, prompts, PR
   facts, or lifecycle history.
6. Orchestrators and workers use separate sandboxes. Their capabilities are
   session-scoped, short-lived, revocable, and cannot call arbitrary coordinator
   APIs or obtain another session's credentials.
7. Terminal bytes use an authenticated WAN relay with bounded replay cursors,
   resize, backpressure, and reconnect. Durable terminal/session facts still
   flow through the normal service and event boundaries.
8. SCM credentials are per-user/per-installation, repository-scoped, and
   short-lived. No shared operator token is written into tenant compute.

The existing placement migrations (`ao_cloud_workspaces` and
`ao_cloud_session_runtimes`) are retained because staging has already applied
them and they model control-plane placement, not AO product state. They are not
currently exposed by handlers. Product tables will be added in independently
reviewable migrations alongside each PostgreSQL store slice.

## PostgreSQL and authentication boundaries

Migration and runtime credentials are separate:

- `AO_CLOUD_MIGRATION_DATABASE_URL` belongs only to `ao-cloud-migrate`.
- `AO_CLOUD_DATABASE_URL` belongs to `ao-cloud` and uses the restricted role
  named by `AO_CLOUD_RUNTIME_DATABASE_ROLE`.
- Runtime startup rejects `SUPERUSER` and `BYPASSRLS` roles.

All six current control-plane tables, including `ao_users` and
`ao_auth_sessions`, have forced RLS. Pre-auth identity upsert and refresh-token
rotation are available only through fixed-search-path `SECURITY DEFINER`
functions owned by a narrowly privileged `NOLOGIN` role. Startup validates RLS
and FORCE RLS on every tenant table.

Authentication routes are limited per source IP in-process; API Gateway also
applies a stage-wide burst/rate limit and overwrites the trusted source-IP
header. Agent credentials are imported only through Electron main after native
consent. PostgreSQL stores ciphertext and a forced-RLS audit trail; workspace
bootstrap resolves the credential owner inside a narrowly privileged database
function.

## Configuration

```bash
export AO_CLOUD_DATABASE_URL='postgres://ao_runtime:...@db.example/ao_cloud?sslmode=verify-full&sslrootcert=/path/to/rds.pem'
export AO_CLOUD_GOOGLE_CLIENT_IDS='desktop-oauth-client.apps.googleusercontent.com'
export AO_CLOUD_ALLOWED_EMAILS='maintainer@example.com'
export AO_CLOUD_ACCESS_TOKEN_KEY_BASE64="$(openssl rand -base64 32)"
export AO_CLOUD_CREDENTIAL_KMS_KEY_ID='arn:aws:kms:us-west-2:123456789012:key/...'
```

Optional settings:

```bash
export AO_CLOUD_ADDR='127.0.0.1:8080'
export AO_CLOUD_ACCESS_TOKEN_ISSUER='ao-cloud'
export AO_CLOUD_ACCESS_TOKEN_AUDIENCE='ao-desktop'
export AO_CLOUD_ACCESS_TOKEN_TTL='15m'
export AO_CLOUD_REFRESH_TOKEN_TTL='720h'
```

Run migrations and the API:

```bash
export AO_CLOUD_MIGRATION_DATABASE_URL='postgres://migration_owner:...@db.example/ao_cloud'
export AO_CLOUD_RUNTIME_DATABASE_ROLE='ao_cloud_runtime'
export AO_CLOUD_RUNTIME_DATABASE_PASSWORD='generate-and-store-securely'
cd backend
go run ./cmd/ao-cloud-migrate
go run ./cmd/ao-cloud
```

The service speaks plain HTTP only inside the ECS task network. AWS terminates
public TLS at API Gateway and reaches ECS through a VPC link and internal ALB.
Database connections use hostname verification and the checksum-pinned regional
RDS CA bundle. See [`deploy/cloud/README.md`](../deploy/cloud/README.md).

## Merge gates for project/session support

Cloud project controls remain absent until all of these are true:

- project and session writes use tenant-scoped PostgreSQL store adapters behind
  the existing service interfaces;
- hosted reads and mutations pass contract-parity tests against the same API
  shapes used by local AO;
- change delivery has a durable Postgres event/outbox source and reconnect
  cursor semantics;
- compute capabilities are session-scoped rather than coordinator-wide;
- workspace/session quotas, idempotent delete, idle pause, expiry, and failed-
  provisioning cleanup are enforced by a durable reconciler;
- cross-tenant integration tests exercise owner, co-member, disabled-member,
  and foreign-organization cases against real PostgreSQL; and
- no customer credential or durable AO state depends on sandbox lifetime.

This prevents the staging POC from becoming an accidental second product
architecture that the team would later have to migrate in place.

## Implementation sequence

The existing core is already close to the required seam: services and
lifecycle code define narrow, domain-typed store interfaces and do not import
SQL packages. The remaining concrete SQLite coupling is concentrated in daemon
wiring. Preserve the consumer-owned interfaces; do not introduce a generic
repository or expose SQL transactions to services.

1. **Storage seam, no behavior change.** Move the consumer store contracts to
   `internal/ports` (leaving aliases at their old packages during migration),
   add a daemon-wiring aggregate only for construction, and make wiring depend
   on the port. Add an import-boundary test forbidding `database/sql`, `pgx`,
   and generated database packages outside `internal/storage`.
2. **Remove SQLite-only ordering assumptions.** Add an explicit monotonic
   sequence to conversation turns and stop ordering by SQLite `rowid`.
3. **Conformance harness.** Add `internal/storage/storagetest` and run the same
   domain behavior against adapters. SQLite remains the only active adapter at
   this point.
4. **Independent PostgreSQL baseline.** Keep SQLite migrations frozen. Create a
   separate squashed PostgreSQL schema and a second generated query set with
   identical query names and domain type overrides. A manifest test compares
   logical tables/columns and a query-name test prevents dialect drift.
5. **Port in dependency order.** Implement projects/workspace metadata first;
   then sessions, worktrees, cleanup facts, interface transitions, and change
   events; then SCM/PR facts; small settings/notification/terminal metadata;
   reviews; agent switching; usage; and finally conversations/chat.
6. **Atomic cutover.** Foreign keys and the no-dual-write rule mean the hosted
   process must not split product tables between databases. SQLite serves all
   product traffic until the PostgreSQL adapter passes the complete conformance
   suite, then one storage-driver selection changes the whole process.
7. **Hosted API composition.** Google/AO authentication becomes middleware in
   front of the existing `internal/httpd` router and service set. The separate
   `/api/cloud/v1` surface remains only for auth, organization administration,
   placement, and billing—not duplicate project/session endpoints.

Tenant identity travels in `context.Context`, not in hundreds of method
signatures. The PostgreSQL adapter fails closed when tenant context is absent,
sets `ao.user_id` and `ao.org_id` transaction-locally, and still includes
explicit tenant predicates. Global background scans become per-tenant loops
driven by a narrow tenant-directory port; they never bypass RLS.

PostgreSQL change delivery keeps database-triggered CDC so domain writes and
events stay atomic. Its poller cannot naively advance on an identity sequence:
concurrent transactions may allocate sequence values and commit out of order.
The Postgres source must use a transaction-visibility watermark (for example an
`xmin`/snapshot boundary), with a concurrent-writer conformance test proving a
cursor cannot skip a late commit.

SQL storage does not cover repository files, attachments, or device-specific
state. Those remain separate ports: object/blob storage for attachments,
workspace/repository adapters for checkouts and overlays, and a dedicated
device registry. None may be smuggled into the Postgres store or persisted only
inside compute.

### Compute capability boundary

Do not give a worker a signed URL to a whole coordinator daemon. Use an opaque,
random capability whose one-way verifier is bound server-side to exactly one
workspace, one session, and a small operation allowlist. Its lifetime follows
the session lifecycle and deletion revokes it immediately. The raw token never
appears in process arguments, logs, Postgres, or renderer state.

Any coordinator-like process exposed beyond loopback needs a separate published
listener with bearer authentication, a route allowlist, session self-binding,
strict origin handling, and normal TLS verification for terminal WebSockets.
The existing unauthenticated loopback listener must not be republished through
a preview URL. Desktop administration uses a distinct revocable capability;
worker capabilities cannot resume or delete workspaces and cannot address sessions outside their own workspace. Preview, browser, and activity operations are further restricted to the worker's own session.

Existing staging sandboxes from the removed POC are not migration candidates:
they were issued non-revocable coordinator URLs and must be destroyed before a
new compute-plane preview is enabled.
