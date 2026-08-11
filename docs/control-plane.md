# Control-plane state and cluster behavior

The control plane is stateless between HTTP requests. PostgreSQL is the source
of truth for identities, memberships, projects, session/workspace intent,
commands, turns, events, and audit records. Any healthy replica can serve the
next request.

## Durable session creation

Creating a session commits one PostgreSQL transaction containing:

1. an idempotency command receipt;
2. the session and generated branch;
3. a one-to-one sandbox row with `desired_state = running` and
   `observed_state = requested`;
4. the initial prompt event and queued turn, when a prompt was supplied;
5. an audit event; and
6. the completed command result.

The sandbox row is desired-state intent only. This service does not call ECS,
Daytona, Docker, or any worker API. A future reconciler can claim requested
sandboxes and update their observed state without changing the client-facing
creation flow.

`AO_CLOUD_SANDBOX_PROVIDER` selects the default provider recorded on new
sandboxes. An explicit provider connection, when supplied, determines the
provider instead.

## Durable messages and replay

Sending a message also commits atomically:

- an idempotency command receipt;
- a gap-free sequence allocated from the session row;
- a `chat.user_message` event;
- one queued turn; and
- a content-free audit record containing only the event sequence.

Only one unfinished turn is permitted per session by a database constraint.
Retries with the same idempotency key return the original event. Reusing a key
for different input returns a conflict.

`GET .../chat-events` replays committed client events after a sequence.
`GET .../events` provides server-sent events by replaying and polling
PostgreSQL. It keeps no replica-local subscription state, so reconnecting to a
different replica is safe: the client resumes from its last sequence. The
polling implementation is intentionally simple for the first deployment; a
database notification or broker may later reduce polling latency without
changing event durability.

## Replica lifecycle

- `/healthz` reports process liveness.
- `/readyz` checks PostgreSQL and returns unavailable while the process is
  draining.
- Both successful probes report `environment` and `release`, and every response
  includes `X-AO-Release`, so load-balancer checks and rollout debugging can
  identify the exact image revision serving traffic.
- On shutdown, the process marks itself draining before gracefully closing the
  HTTP server.
- Long-lived event streams have no global HTTP write timeout. Request bodies
  remain bounded, and server read/header/idle timeouts remain enabled.
- Production startup rejects a runtime database role with `SUPERUSER` or
  `BYPASSRLS`. `AO_CLOUD_MIGRATION_DATABASE_URL` may hold a separate elevated
  migration credential; ordinary requests only use `AO_CLOUD_DATABASE_URL`.

Sticky routing may improve cache locality later, but correctness never depends
on it. Authentication caches and development rate-limit counters are
replica-local optimizations; authorization and all product state are checked
against PostgreSQL.

## Version and environment boundaries

- The public HTTP contract is versioned under `/api/cloud/v1`.
- PostgreSQL changes are ordered Goose migrations and are never inferred from
  the running binary.
- `AO_CLOUD_RELEASE` identifies the deployed image, normally with an immutable
  Git SHA or release tag. It is required in `staging` and `production`.
- `staging` and `production` are both hosted modes: local authentication is
  rejected and the runtime database role must not bypass RLS.

Separate staging/production ECS services, ALB target groups, Secrets Manager
paths, RDS databases, image promotion, canary percentages, and rollback rules
belong to deployment infrastructure rather than application branching.

## Deliberate exclusions

This slice does not provision or reconcile sandboxes, connect workers, execute
turns, reap idle resources, proxy terminals/files, integrate GitHub, or deploy
AWS infrastructure. Those components consume the durable rows above and are
separate from this non-provisioning control-plane boundary.
