# AO Cloud

Private AO control-plane service. This foundation contains:

- the 28-table PostgreSQL founding schema;
- WorkOS access-token verification and profile resolution;
- opt-in local email/password authentication for development;
- organization membership checks backed by PostgreSQL row-level security;
- organization-scoped project and session APIs matching the public Cloud contract;
- idempotent project/session creation and cursor pagination;
- explicit per-session mode and denied-command policy;
- durable workspace intent for every session; and
- durable message queues, event replay, and cluster-safe SSE reconnects;
- GitHub App installation verification, repository grants, and durable
  webhook processing; and
- Dockerized local development plus an isolated hosted-staging launcher.

Cloud UI, worker provisioning/execution, terminal/files, personal GitHub OAuth,
PR/issue synchronization, and sharing behavior are intentionally not
implemented yet. See
[`docs/control-plane.md`](docs/control-plane.md) for durable-state and cluster
behavior and [`docs/deployment.md`](docs/deployment.md) for staging and
production deployments.

## Environment model

- **Local (`npm run cloud:local`)** uses local email/password auth, local
  PostgreSQL, and the local control-plane container. It does not load WorkOS or
  GitHub App credentials. Docker workers are the intended execution backend,
  but no worker is started until the worker protocol is implemented.
- **Staging (`npm run cloud:staging`)** runs the desktop locally against
  `https://staging-api.aoagents.dev`. The hosted staging control plane uses the
  shared WorkOS environment and its own staging database. Future workers run in
  staging, not on the developer's machine.
- **Production** uses `https://api.aoagents.dev`, the shared WorkOS environment,
  the production database, and the one production GitHub App. There is no
  supported local-desktop-against-production development command.

GitHub App credentials are rejected outside production because setup, OAuth,
and webhook callback state is durable in the production database. Local and
staging GitHub UI must remain disabled until a production broker protocol can
return signed, environment-scoped repository grants. Sharing credentials alone
would send callbacks to the wrong database and is not supported.

## Run locally

The default development loop requires Docker with Compose:

```bash
npm run cloud:local
```

This builds the same distroless control-plane image used in hosted
environments, starts PostgreSQL on `127.0.0.1:54329`, runs migrations with an
isolated non-superuser schema-owner role, grants only runtime DML privileges to
the separate non-superuser `ao_cloud_app` role, disables login for the
image-bootstrap superuser, and exposes the API on
`http://127.0.0.1:8081` (avoiding the desktop daemon's usual port). Local auth
is enabled. No worker is started: sessions store durable execution intent, but
provisioning remains a separate feature.

Use `npm run cloud:local:down` to stop containers while retaining data and
`npm run cloud:local:reset` to stop them and delete the local database volume.
Ports can be changed with `AO_CLOUD_PORT` and `AO_CLOUD_POSTGRES_PORT`.
`npm run cloud:local:smoke` uses an isolated Compose project and random
loopback ports to verify the complete create/restart/persist/down/reset
lifecycle without touching normal local Cloud data.

To launch the desktop's currently implemented auth-only flow against a hosted
staging deployment:

```bash
npm run cloud:staging
```

The launcher defaults to `https://staging-api.aoagents.dev` and the non-secret
staging WorkOS client ID. `AO_CLOUD_STAGING_URL` and `VITE_WORKOS_CLIENT_ID`
remain available as explicit overrides. The command requires HTTPS, refuses
redirects and production responses, verifies `/readyz` reports
`environment=staging`, and isolates Electron and daemon state under
`~/.ao/staging-desktop` by default. If public ingress is unavailable, it exits
with the failing readiness URL and HTTP/TLS error before Electron starts. The
desktop currently uses the URL for staging preflight and future Cloud API
calls; this branch does not add Cloud project/session UI. WorkOS desktop
authentication continues to use the `ao-app://callback` deep link.

For a direct Go loop, requirements are Go 1.26.5 and PostgreSQL 15 or newer.
Development and test environments can apply embedded Goose migrations at
startup, using `AO_CLOUD_MIGRATION_DATABASE_URL` when set and
`AO_CLOUD_DATABASE_URL` otherwise. Hosted deployments run
`/ao-cloud-migrate` as a one-off task before rolling the API service. Local auth
is disabled unless
`AO_CLOUD_LOCAL_AUTH=true`, cannot run alongside WorkOS, and is rejected when
`AO_CLOUD_ENV` is `staging` or `production`.

For WorkOS, set `AO_CLOUD_WORKOS_ISSUER`, `AO_CLOUD_WORKOS_CLIENT_ID`, and
`AO_CLOUD_WORKOS_API_KEY`. The OIDC verifier validates issuer, signature, token
lifetime, and AuthKit's `client_id` claim. The WorkOS API key is server-only and
resolves profile fields that access tokens may omit. The JWKS URL is derived
for standard WorkOS and custom AuthKit domains;
`AO_CLOUD_WORKOS_JWKS_URL` can override it.

Hosted environments use `AO_CLOUD_ENV=staging` or `production` and must set
`AO_CLOUD_RELEASE` to an immutable image tag or Git SHA. Hosted startup fails
if local authentication is enabled or if the runtime database role is a
superuser or can bypass row-level security. Use a restricted runtime credential
for `AO_CLOUD_DATABASE_URL` and, when necessary, a separate schema-migration
credential for `AO_CLOUD_MIGRATION_DATABASE_URL`.

## Database changes and production promotion

Database migrations in `internal/postgres/migrations` are embedded in the same
immutable control-plane image as the API and migration binary. The release flow
is:

1. Add a forward, backward-compatible Goose migration to the repository.
2. Run the migration and integration tests locally.
3. Deploy the commit with `scripts/deploy-staging.sh`. Staging runs that image's
   migrations before updating its API replicas.
4. Verify the release in staging.
5. Promote it with `scripts/promote-production.sh`. Production uses the exact
   scanned image digest currently running in staging and runs that image's
   migrations before updating any production API replica.

If a production migration fails, promotion stops and the existing production
API keeps running. Application rollback does not reverse an applied migration,
so migrations must remain compatible with the previous API release.

Only migration code and the tested application image are promoted. Staging
database rows are never copied to production: users, organizations, projects,
sessions, events, credentials, and all other data remain isolated in their
respective databases. The AWS instances are named
`ao-cloud-staging-storage` and `ao-cloud-production-storage` so the environment
boundary is explicit. See [`docs/deployment.md`](docs/deployment.md) for the full
deployment and rollback procedure.

Each push to private `main` runs
`.github/workflows/update-public-submodule.yml`. When the
`AO_PUBLIC_REPO_TOKEN` repository secret is configured with pull-request write
access to `Untrivial-ai/agent-orchestrator`, it opens or refreshes a public PR
that moves the optional `private/ao-cloud` gitlink to that exact private
commit. Without the secret the pointer job is skipped.

If a verified access token contains `org_id`, that WorkOS organization and the
token's role are synchronized into AO membership. Tokens without `org_id`
receive a personal organization.

## API

All resource routes use `/api/cloud/v1`. Project and session creation require an
`Idempotency-Key` header.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/auth/local/register` | Create a dev user and personal organization |
| `POST` | `/auth/local/login` | Create a revocable dev session |
| `POST` | `/auth/local/logout` | Revoke the current dev session |
| `GET` | `/me` | Return the current user and organization memberships |
| `GET/POST` | `/orgs/{orgId}/projects` | List or create projects |
| `GET` | `/orgs/{orgId}/github/installations` | List connected GitHub App installations |
| `POST` | `/orgs/{orgId}/github/installations/start` | Start a short-lived installation handshake |
| `POST` | `/orgs/{orgId}/github/installations/{id}/sync` | Refresh repository grants |
| `POST` | `/orgs/{orgId}/github/installations/{id}/disconnect` | Revoke AO's installation grants |
| `GET` | `/orgs/{orgId}/github/repositories` | List active and revoked repository grants |
| `POST` | `/orgs/{orgId}/github/projects` | Create a project from an active repository grant |
| `GET/POST` | `/orgs/{orgId}/sessions` | List or create sessions |
| `GET` | `/orgs/{orgId}/sessions/{sessionId}` | Read a session |
| `POST` | `/orgs/{orgId}/sessions/{sessionId}/messages` | Durably queue a message |
| `GET` | `/orgs/{orgId}/sessions/{sessionId}/chat-events` | Replay committed client events |
| `GET` | `/orgs/{orgId}/sessions/{sessionId}/events` | Replay and stream client events over SSE |

WorkOS access tokens and local development tokens both use
`Authorization: Bearer <token>`.

GitHub App setup uses random, hashed, expiring state. The setup callback rotates
that state into a separate OAuth PKCE challenge; the encrypted verifier is
deleted after use. AO binds an installation only after GitHub confirms that the
temporary user token can see and administer it: the user must own a personal
installation or be an active admin of the GitHub organization. User OAuth
tokens and installation tokens are never stored. Webhooks are accepted only
after constant-time HMAC-SHA256 verification, deduplicated by GitHub delivery
ID, and processed in per-installation order through leased PostgreSQL inbox
rows with bounded retries. Sync generations prevent slower stale requests from
restoring newer revoked grants. Repository removals, suspension, deletion, and
explicit disconnect revoke grants; project creation checks an active grant in
the same database transaction.

The GitHub App must request organization **Members: read** permission so AO can
prove that the person completing an organization installation is an active
organization admin. It also needs repository metadata/contents permissions
appropriate for the later worker and the `installation` and
`installation_repositories` webhook events. AO fails closed when the members
permission is absent; ordinary organization members cannot bind an
installation.

Use one GitHub App for staging and production only if its global setup,
OAuth-callback, and webhook URLs point to production. Staging should leave the
GitHub variables unset unless production intentionally brokers the test flow.
WorkOS credentials remain separate and may use the desktop deep link.

## Tenancy

Every organization-owned table has a composite tenant foreign-key path and a
forced PostgreSQL row-level-security policy. Each transaction sets
`ao.user_id` and `ao.org_id`, then verifies an active membership before reading
or writing resources. A caller cannot use another organization's UUID to cross
the boundary.

The service imports shared Go session-status rules from the public AO contract
module. The public OpenAPI document and TypeScript client define account,
project, session, event, and GitHub wire contracts. GitHub integer IDs are
encoded as decimal strings at the HTTP boundary so JavaScript clients do not
lose precision. The `replace` in `go.mod` pins the exact public Go contract
commit under the module's existing canonical import path.

## Hosted monitoring

`scripts/configure-monitoring.py` idempotently enforces the documented log
retention, deployment/health/latency/ECS/RDS alarms, and the `ao-cloud`
CloudWatch dashboard for staging and production:

```bash
AWS_PROFILE=ao-cloud ./scripts/configure-monitoring.py --dry-run
AWS_PROFILE=ao-cloud ./scripts/configure-monitoring.py
```

Set `AO_CLOUD_ALERT_TOPIC_ARN` to attach SNS alarm and recovery notifications.
Without it, alarms still drive deployment rollback and appear in CloudWatch but
do not notify a person. `scripts/verify-ecs-service.py` rejects incomplete
rollouts, mixed task revisions, empty or unhealthy target groups, and
non-`OK` deployment alarms. Deployment and promotion call it before and after
changes.

## Verify

Unit tests do not require PostgreSQL:

```bash
go test ./...
go vet ./...
```

The isolated Compose lifecycle check builds the images, applies fresh
migrations, verifies the HTTP flow and role boundaries, restarts the control
plane, recreates the stack without deleting its volume, and finally proves that
reset deletes the volume:

```bash
npm run cloud:local:smoke
```

Database integration tests run when a disposable PostgreSQL database is
provided:

```bash
AO_CLOUD_TEST_DATABASE_URL='postgres://localhost/ao_cloud_test?sslmode=disable' \
  go test ./... -count=1
```

The integration suite applies the migration, asserts 28 tenant/domain tables
plus two callback-routing tables,
exercises local and WorkOS-backed principals, checks idempotent project,
session, and message creation, verifies concurrent message retries, durable
cross-replica event delivery/replay and workspace intent, and proves
cross-organization reads are denied. Private CI runs those PostgreSQL tests,
Go vet, deployment fixtures, shell checks, an image build, and the isolated
Compose lifecycle.
