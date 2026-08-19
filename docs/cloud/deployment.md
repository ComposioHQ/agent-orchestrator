# AO Cloud deployment

AO Cloud runs as a stateless Go control plane on ECS Fargate, backed by
PostgreSQL on RDS. Daytona owns session compute. Sandbox workers make outbound
HTTPS connections to the control plane; neither the database nor a sandbox has
public ingress.

The implementation lives in the main repository:

- `backend/cmd/ao-cloud` — API, reconciliation, SCM, and lifecycle loops;
- `backend/cmd/ao-cloud-migrate` — migration-first database bootstrap;
- `backend/cmd/ao-worker` — outbound-only session worker;
- `backend/internal/cloud/postgres/migrations` — multi-tenant PostgreSQL schema;
- `deploy/cloud/terraform` — AWS network, RDS, ECS, ALB, IAM, secrets, and alarms;
- `deploy/cloud/scripts/deploy-staging.sh` — immutable image publication and
  migration-first rollout.

The old Next.js Cloud application is intentionally not deployed. Electron is
the product UI and will consume `/api/cloud/v1` through the same controllers
and components used by local projects.

## Trust boundaries

- Google establishes a user's identity. The desktop sends a Google ID token to
  `POST /api/cloud/v1/auth/google`; AO verifies issuer, audience, authorized
  party, and verified email before issuing a 15-minute AO access token and a
  rotating opaque refresh token.
- Organization membership is read from PostgreSQL on every authenticated
  request. It is not trusted from Google or cached in AO access-token claims.
- The API uses a restricted RDS role. Hosted startup rejects `SUPERUSER` or
  `BYPASSRLS`; the elevated owner URL is present only in one-off migration
  tasks.
- Daytona credentials, GitHub App credentials, signing keys, and database URLs
  are loaded from KMS-backed Secrets Manager entries. They never enter an image
  or browser bundle.
- A sandbox receives one single-use bootstrap ticket. The resulting worker JWT
  is short-lived and bound to organization, session, worker ID, and epoch.
- Coding-agent credentials are encrypted with AO-held AES-GCM keys and released
  only to the current worker epoch. They are not written into terminal events.
- GitHub checkout/push grants are repository-scoped and short-lived. Staging
  obtains grants from production through a mutually authenticated repository
  broker instead of holding production GitHub App credentials.

## AWS resources

The Terraform stack creates:

- one VPC across two availability zones;
- public ALB subnets and private ECS/RDS subnets, with one NAT gateway;
- TLS-only public ALB ingress and security-group-scoped database ingress;
- encrypted PostgreSQL 17 with backups, deletion protection by default, and no
  public endpoint;
- KMS-backed Secrets Manager entries and CloudWatch logs;
- immutable, scan-on-push ECR repositories for control-plane and worker images;
- separate API and migration ECS task definitions and an API service;
- deployment-circuit-breaker support, a 5xx rollback alarm, and optional SNS;
- a CPU target-tracking policy with a two-task floor after bootstrap.

Terraform contains sensitive values in state even though outputs are marked
sensitive. Use an encrypted, access-controlled remote state backend. Never
commit a populated `.tfvars` file or state file.

## Prerequisites

Before provisioning staging, obtain:

1. AWS credentials allowed to create the resources above;
2. an ACM certificate in the target region and a DNS name;
3. Google OAuth client IDs for the Electron clients;
4. a Daytona API key, target, and snapshot built from
   `deploy/cloud/daytona/Sandbox.Dockerfile`;
5. the production repository-broker URL plus two independently generated
   32-byte-or-longer shared tokens.

The Daytona egress allow list must cover the exact control-plane host,
Anthropic API, GitHub API and object hosts, and package registries used by the
pinned snapshot. AO disables Daytona auto-stop, auto-pause, and auto-delete;
only the durable AO desired state controls lifecycle.

Production additionally requires a GitHub App with these callbacks:

- `${AO_CLOUD_PUBLIC_URL}/api/cloud/v1/github/install/setup`
- `${AO_CLOUD_PUBLIC_URL}/api/cloud/v1/github/oauth/callback`
- `${AO_CLOUD_PUBLIC_URL}/api/cloud/v1/github/user/callback`
- `${AO_CLOUD_PUBLIC_URL}/api/cloud/v1/github/webhooks`

The ECR repositories are account-shared. Set
`manage_ecr_repositories = false` in the production stack and promote the exact
healthy staging digests with `deploy/cloud/scripts/promote-production.sh`.

## Bootstrap staging

Copy `deploy/cloud/terraform/terraform.tfvars.example` outside the repository,
fill it with real values, and initialize an encrypted backend. The first apply
keeps the API service at zero tasks so a placeholder image cannot start before
database migration.

```bash
terraform -chdir=deploy/cloud/terraform init \
  -backend-config=/secure/path/backend.hcl
terraform -chdir=deploy/cloud/terraform plan \
  -var-file=/secure/path/staging.tfvars
terraform -chdir=deploy/cloud/terraform apply \
  -var-file=/secure/path/staging.tfvars
```

Terraform creates the ECR repositories and ECS templates. Commit the release,
ensure the worktree is clean, then deploy that exact commit:

```bash
AWS_REGION=ap-south-1 \
deploy/cloud/scripts/deploy-staging.sh "$(git rev-parse HEAD)"
```

The script:

1. validates Daytona, Google-auth, and worker secret documents;
2. builds Linux/amd64 control-plane and worker images;
3. pushes immutable tags, resolves digests, checks image contents, and blocks
   non-allowlisted high/critical ECR findings;
4. renders new task definitions from the Terraform templates;
5. starts and waits for the migration task;
6. creates or rotates the restricted runtime DB login, applies Goose
   migrations under an advisory lock, and grants only runtime privileges;
7. updates the API service to two tasks with circuit-breaker/alarm rollback;
8. waits for healthy ALB targets and verifies exact control and worker image
   digests.

After the first successful release, set `deployment_enabled = true` and apply
Terraform again. This installs the two-task autoscaling floor without replacing
the digest-pinned task definition owned by the release script.

## Smoke test

Use a real Google ID token whose audience appears in
`AO_CLOUD_GOOGLE_CLIENT_IDS`:

```bash
curl --fail-with-body https://staging-api.aoagents.dev/readyz
curl --fail-with-body \
  -H 'Content-Type: application/json' \
  --data '{"idToken":"REDACTED"}' \
  https://staging-api.aoagents.dev/api/cloud/v1/auth/google
```

Do not paste returned tokens into logs or shell history. The full acceptance
test must then create an org/project, store one Claude credential, create a
session, observe a Daytona worker heartbeat, exchange terminal input/output,
raise or inspect a pull request through a repository grant, pause/resume the
sandbox, and delete it without orphaned compute.

## Operations and rollback

- `/healthz` is process liveness; `/readyz` checks PostgreSQL and draining.
- `X-AO-Release` on every response identifies the serving release.
- User events and terminal bytes are durable and sequence-addressed, so a
  reconnect may land on another ECS task without sticky routing.
- Provider lookup errors are inconclusive. They never prove a sandbox is gone.
- Schema migrations are forward-only. Roll back the ECS task definition, not
  the database migration; every migration must remain compatible with the
  previous serving image during the rollout window.
- Use `deploy/cloud/scripts/verify-ecs-service.py` after any manual operation.
  It rejects mixed revisions, unhealthy targets, missing replicas, a bad alarm,
  or an unexpected image digest.

Never place the elevated migration URL on the API task, enable public RDS
access, enable provider lifecycle timers, or expose a worker port.
