# Deployments

## Staging

AO Cloud staging runs the control plane as a stateless ECS/Fargate service.
PostgreSQL is the durable source of truth, so any healthy replica can serve a
request. The service starts at two replicas and can scale from two to six on
average CPU utilization.

## Release flow

Run from a clean private `main` checkout:

```bash
AWS_PROFILE=ao-cloud ./scripts/deploy-staging.sh
```

The script requires `AO_CLOUD_RELEASE` to resolve to the clean checkout's
current full Git SHA and:

1. Builds one non-root, read-only `linux/amd64` image.
2. Pushes an immutable release tag to `ao-cloud-control-plane`.
3. requires the ECR basic scan to finish with no critical or high findings.
4. Registers digest-pinned API and migration task definitions.
5. Runs `/ao-cloud-migrate` as a one-off Fargate task and stops on failure.
6. Rolls both API replicas only after migrations succeed.
7. Waits for ECS and both ALB targets to become healthy.

The verifier rejects fewer than two desired tasks, pending tasks, mixed
task-definition revisions, an incomplete primary deployment, an empty target
group, unhealthy targets, or a deployment alarm that is not `OK`. Interrupted
deployment scripts stop an unfinished migration task.

Re-running the same release reuses its immutable ECR image. A new code version
creates new task-definition revisions; it never mutates an older image tag.

## Runtime resources

- ECS cluster: `ao-cloud-staging`
- ECS service: `ao-cloud-staging-api`
- API task family: `ao-cloud-staging-api`
- migration task family: `ao-cloud-staging-migrate`
- PostgreSQL: `ao-cloud-staging-storage`
- public HTTPS ALB: `ao-cloud-staging-public`
- hostname: `staging-api.aoagents.dev`
- target group: `ao-cloud-staging-public-cp`
- CloudWatch log group: `/ao-cloud/staging/control-plane` (30-day retention)
- ECR repository: `ao-cloud-control-plane` (immutable tags, 30-image retention)

The ALB probes `/readyz`, which checks both draining state and database
connectivity. ECS keeps at least 100% of the desired replicas healthy during a
rollout. Its deployment circuit breaker rolls back failed starts, and the
`ao-cloud-staging-target-5xx` alarm rolls back a release with sustained target
5xx responses. `ao-cloud-staging-unhealthy-targets` tracks unhealthy replicas.

## Monitoring

```bash
AWS_PROFILE=ao-cloud ./scripts/configure-monitoring.py --dry-run
AWS_PROFILE=ao-cloud ./scripts/configure-monitoring.py
```

This idempotently enforces 30-day staging and 90-day production log retention,
preserves the target-5xx deployment rollback alarms, and configures
unhealthy-target, latency, ECS CPU/memory, and RDS
CPU/free-storage/free-memory alarms. The `ao-cloud` dashboard shows ALB, ECS,
and RDS metrics for both environments. Set `AO_CLOUD_ALERT_TOPIC_ARN` to attach
SNS alarm and recovery notifications; otherwise the alarms have no human
notification action.

## Secrets

ECS reads these Secrets Manager entries through the dedicated staging execution
role:

- `ao-cloud/staging/workos`
- `ao-cloud/staging/database-url`
- `ao-cloud/staging/migration-database-url`

The API task gets only the runtime database credential. The elevated migration
credential is available only to the one-off migration task. Secrets are not
baked into the image or task-definition environment.

Database password rotation must update the corresponding URL secret before the
next rollout. For an immediate WorkOS or runtime database secret rotation,
force a new ECS deployment so every replica fetches the new value.

## Network boundary

The staging API is exposed only through HTTPS at
`https://staging-api.aoagents.dev`. Cloudflare serves DNS only; ACM terminates
TLS on the public ALB. The ALB security group admits port 443 and the task
security group admits port 8080 only from that ALB. Tasks still need to move to
private subnets with NAT or VPC endpoints instead of public task IPs.

## Rollback

ECS automatically returns to the last healthy task definition when startup,
health checks, or the deployment alarm fail. To select an older healthy release
manually:

```bash
AWS_PROFILE=ao-cloud \
  ./scripts/rollback-release.sh staging ao-cloud-staging-api:<revision>

AO_CLOUD_APPROVE_PRODUCTION_ROLLBACK=1 \
  AWS_PROFILE=ao-cloud \
  ./scripts/rollback-release.sh production ao-cloud-production-api:<revision>
```

The guarded script requires a digest-pinned task definition from the correct
environment, waits for ECS stability, and verifies tasks, targets, and alarms.
It does not reverse database migrations.

Schema migrations must remain backward-compatible with the previous API
revision so that rolling deploys and application rollback are safe.

## Production promotion

Production is deliberately a separate environment. It has its own PostgreSQL
instance, ECS cluster, service, ALB, IAM roles, logs, alarms, and Secrets Manager
entries. Staging and production share only the immutable ECR image selected for
promotion.

Run this only after the release is healthy in staging:

```bash
AO_CLOUD_APPROVE_PRODUCTION=1 \
  AWS_PROFILE=ao-cloud \
  ./scripts/promote-production.sh
```

The production script does not build an image. It reads the release and
digest-pinned image from the healthy staging service, requires the ECR scan to
be complete with no high or critical findings, and refuses a requested release
that is not currently running in staging. It verifies both services before
changing production. New production task revisions are derived from the
existing production definitions—not staging—so production-only secrets survive
and staging variables, URLs, log groups, or secret ARNs cannot cross the
environment boundary. It then:

1. Registers production API and migration task definitions using that exact
   digest.
2. Runs `/ao-cloud-migrate` against production as a one-off task.
3. Refreshes the restricted runtime role's grants, including default privileges
   for objects created by future migrations.
4. Leaves the existing API service untouched if migration or grant application
   fails.
5. Rolls two production replicas, waits for ECS stability, and requires every
   ALB target to be healthy.
6. Verifies that production is running the same image digest and release as
   staging.

This promotes migration code, not staging data. Each environment retains its
own users, organizations, projects, sessions, events, and credentials.

### Production resources

- PostgreSQL: `ao-cloud-production-storage` (encrypted, single-AZ
  `db.t4g.small`, 7-day backups, deletion protection)
- ECS cluster: `ao-cloud-production`
- ECS service: `ao-cloud-production-api`
- API task family: `ao-cloud-production-api`
- migration task family: `ao-cloud-production-migrate`
- public HTTPS ALB: `ao-cloud-production-public`
- hostname: `api.aoagents.dev`
- target group: `ao-cloud-production-public-cp`
- CloudWatch log group: `/ao-cloud/production/control-plane` (90-day retention)
- autoscaling: two to six replicas at 60% average CPU utilization
- deployment alarms: `ao-cloud-production-target-5xx` and
  `ao-cloud-production-unhealthy-targets`

The service reads only these production-scoped secrets:

- `ao-cloud/production/workos`
- `ao-cloud/production/database-url`
- `ao-cloud/production/migration-database-url`

Staging and production intentionally use the same WorkOS environment. This
shares users and provider configuration across both AO environments; split them
into separate WorkOS environments later only if stronger environment isolation
becomes necessary.

### Promotion and rollback limits

If a migration fails, promotion stops before the API changes. If new API tasks
fail startup or health checks, the ECS deployment circuit breaker restores the
last healthy task definition. The release script also checks the final task
definition so that an automatic rollback cannot be reported as a successful
promotion.

Application rollback does not reverse a completed database migration. Every
production migration must therefore use an expand-and-contract sequence and
remain compatible with the previous API release. Destructive cleanup belongs in
a later release after the old application version can no longer run.

Migration processes default to a 15-minute
`AO_CLOUD_MIGRATION_TIMEOUT`. Context cancellation bounds advisory-lock waits
and blocked DDL. If an ECS waiter or script is interrupted before migration
completion, the deployment trap stops that task instead of leaving it running
without an owner.

### Public ingress

Staging and production use internet-facing HTTPS ALBs:

- `ao-cloud-staging-public` for `staging-api.aoagents.dev`
- `ao-cloud-production-public` for `api.aoagents.dev`

ACM certificates in `eu-north-1` terminate TLS. Cloudflare keeps the API and ACM
validation CNAMEs in DNS-only mode. Each ECS service is attached only to its
public target group, and `/healthz` plus `/readyz` are verified through the
public hostnames. CloudWatch deployment alarms and the operations dashboard use
the public ALB and target-group dimensions.

The old internal ALBs and target groups have no ECS targets and can be deleted
after the public ingress observation period. Remaining network work is to move
tasks into private subnets with NAT or the required VPC endpoints.

Fargate tasks currently use the existing VPC's public subnets with public IPs,
while security groups admit application traffic only from an ALB and database
traffic only from the environment's task group.

### Authentication and callback readiness

Desktop WorkOS login uses PKCE and the custom `ao-app://callback` redirect. The
public API hostname is therefore not a WorkOS login callback: the desktop app
only needs its Cloud client base URL changed to the environment's HTTPS
hostname. Access-token verification and user synchronization are stateless
across API replicas, with durable identity and organization state in PostgreSQL.
No ALB stickiness is required.

GitHub App setup, OAuth verification, repository synchronization, disconnect,
and webhook handlers are implemented with PostgreSQL-backed state:

- setup URL: `https://api.aoagents.dev/api/cloud/v1/github/install/setup`
- OAuth callback:
  `https://api.aoagents.dev/api/cloud/v1/github/oauth/callback`
- webhook URL: `https://api.aoagents.dev/api/cloud/v1/github/webhooks`

The shared GitHub App must route these three global URLs to production. Staging
must not independently enable the same App credentials: its callback state
would live in a different database. Staging may exercise the public typed
contract and WorkOS auth, but its GitHub UI must remain disabled until the
production broker exists. The current hosted tasks do not map GitHub
credentials. Before enabling the production task, store the App ID, slug, client
credentials, RSA private key, webhook secret, and a base64 32-byte state key in
Secrets Manager and map all `AO_CLOUD_GITHUB_*` variables plus
`AO_CLOUD_PUBLIC_URL=https://api.aoagents.dev` into the task definition.
Configure the App with organization `Members: read`; AO uses that permission to
verify active organization-admin authority before binding an installation.

No callback or webhook relies on replica memory. Callback routes, encrypted
PKCE verification state, installation routing, repository grants, and the
leased webhook inbox are durable in the production database, so any healthy
replica can receive a request and no ALB stickiness is required.
