# AWS staging deployment

This directory deploys the PostgreSQL and Google-auth control-plane foundation
to a cost-oriented staging environment in `us-west-2`. It deliberately does not
provision customer projects, sessions, or sandboxes yet.

## Architecture

- API Gateway provides public AWS-managed HTTPS and stage throttling.
- A VPC link reaches an internal Application Load Balancer.
- One ECS Fargate task runs `ao-cloud`; its security group accepts traffic only
  from the load balancer.
- A single-AZ encrypted RDS PostgreSQL 16 instance stays in isolated subnets and
  accepts traffic only from the ECS task security group.
- RDS manages the migration-owner secret. Separate Secrets Manager records hold
  the restricted runtime URL, Google client IDs, email allowlist, and signing
  key. Terraform creates secret containers but never receives their values.
- A dedicated rotating KMS key wraps per-credential data keys. The ECS task
  role can only generate/decrypt data keys when the tenant and Claude Code
  encryption-context fields are present.
- CodeBuild builds the exact commit and ECR stores immutable images.
- CloudWatch receives API, migration, and API Gateway logs.

This is a staging stack. Production still needs multi-AZ RDS, autoscaling, a
custom domain, WAF, alarms, backup/restore exercises, and a reviewed
expand/migrate/contract rollout process.

## Deploy

Prerequisites are AWS CLI, Terraform 1.10+, `jq`, `openssl`, and credentials
allowed to create the resources above:

```bash
export AO_CLOUD_GOOGLE_CLIENT_IDS='123456789-example.apps.googleusercontent.com'
export AO_CLOUD_ALLOWED_EMAILS='maintainer@example.com'
deploy/cloud/deploy-staging.sh
```

The allowlist is a required, comma-separated signup gate. Values are written to
AWS Secrets Manager and injected into ECS; they are not Terraform variables,
image layers, logs, or committed files.

The script:

1. creates an encrypted, versioned, public-blocked S3 state bucket;
2. provisions networking, RDS, secrets, ECR, CodeBuild, ECS, API Gateway, and
   logging;
3. generates secrets outside Terraform state;
4. builds and pushes the exact current commit;
5. stages the migration image while the previous API stays online, then runs
   migrations before rolling the API forward;
6. forces a fresh rollout when only secret values changed and verifies that all
   pre-deploy tasks were replaced; and
7. checks health, readiness, invalid identity, and malformed refresh/logout
   behavior through the public HTTPS endpoint.

Both migration and runtime connections use full certificate and hostname
verification. A failed migration restores the previous database secret and
leaves the serving revision online.

This image and script intentionally support only `us-west-2`. When AWS rotates
the regional RDS bundle, download it from the AWS trust-store endpoint, inspect
certificate subjects and validity, then update `RDS_CA_BUNDLE_SHA256` in the
Dockerfile. Never remove the checksum check merely to make a build pass.
