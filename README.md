# AO Cloud

Private AO control-plane service. This foundation contains:

- the 28-table PostgreSQL founding schema;
- WorkOS access-token verification and profile resolution;
- opt-in local email/password authentication for development;
- organization membership checks backed by PostgreSQL row-level security;
- organization-scoped project and session APIs matching the public Cloud contract;
- idempotent project/session creation and cursor pagination;
- durable workspace intent for every session; and
- durable message queues, event replay, and cluster-safe SSE reconnects.

Cloud UI, worker provisioning/execution, terminal/files, GitHub behavior, and
sharing behavior are intentionally not implemented yet. See
[`docs/control-plane.md`](docs/control-plane.md) for durable-state and cluster
behavior and [`docs/deployment.md`](docs/deployment.md) for staging and
production deployments.

## Run locally

Requirements: Go 1.25.7 or newer and PostgreSQL 15 or newer.

```bash
createdb ao_cloud
cp .env.example .env
set -a; source .env; set +a
AO_CLOUD_LOCAL_AUTH=true go run ./cmd/ao-cloud
```

Development and test environments apply embedded Goose migrations at startup,
using `AO_CLOUD_MIGRATION_DATABASE_URL` when set and
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
| `GET/POST` | `/orgs/{orgId}/sessions` | List or create sessions |
| `GET` | `/orgs/{orgId}/sessions/{sessionId}` | Read a session |
| `POST` | `/orgs/{orgId}/sessions/{sessionId}/messages` | Durably queue a message |
| `GET` | `/orgs/{orgId}/sessions/{sessionId}/chat-events` | Replay committed client events |
| `GET` | `/orgs/{orgId}/sessions/{sessionId}/events` | Replay and stream client events over SSE |

WorkOS access tokens and local development tokens both use
`Authorization: Bearer <token>`.

## Tenancy

Every organization-owned table has a composite tenant foreign-key path and a
forced PostgreSQL row-level-security policy. Each transaction sets
`ao.user_id` and `ao.org_id`, then verifies an active membership before reading
or writing resources. A caller cannot use another organization's UUID to cross
the boundary.

The service imports session status rules from the public AO contract module. The
`replace` in `go.mod` pins the public `feat/cloud-refactor` commit under the
module's existing canonical import path.

## Verify

Unit tests do not require PostgreSQL:

```bash
go test ./...
go vet ./...
```

Database integration tests run when a disposable PostgreSQL database is
provided:

```bash
AO_CLOUD_TEST_DATABASE_URL='postgres://localhost/ao_cloud_test?sslmode=disable' \
  go test ./... -count=1
```

The integration suite applies the migration, asserts exactly 28 AO tables,
exercises local and WorkOS-backed principals, checks idempotent project,
session, and message creation under concurrent retries, verifies durable event
replay and workspace intent, and proves cross-organization reads are denied.
