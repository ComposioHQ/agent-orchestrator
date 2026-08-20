# AWS staging deployment

This directory deploys the PostgreSQL/auth control-plane foundation to a
cost-oriented staging environment in `us-west-2`.

## Architecture

- API Gateway provides the public AWS-managed HTTPS endpoint.
- A VPC link reaches an internal Application Load Balancer.
- One ECS Fargate task runs `ao-cloud` in public subnets with outbound internet
  access for Google OIDC discovery. Its security group accepts traffic only
  from the internal load balancer.
- A single-AZ encrypted RDS PostgreSQL 16 instance stays in isolated database
  subnets and accepts traffic only from the ECS task security group.
- RDS manages and rotates the migration-owner secret. Separate Secrets Manager
  records hold the restricted runtime URL and AO signing key. Terraform creates
  secret containers but never receives their values.
- CodeBuild builds the exact Git commit and pushes an immutable image to ECR.
- CloudWatch receives API, migration, and API Gateway logs.

This is intentionally a staging stack. It excludes production multi-AZ RDS,
autoscaling, a custom domain, WAF, Daytona, SCM, and session lifecycle workers.

## Deploy

Prerequisites are AWS CLI, Terraform 1.10+, `jq`, `openssl`, and credentials
authorized to create the resources above. Set the public Google desktop OAuth
client ID, then run:

```bash
export AO_CLOUD_GOOGLE_CLIENT_IDS='123456789-example.apps.googleusercontent.com'
deploy/cloud/deploy-staging.sh
```

The script:

1. creates an encrypted, versioned, public-blocked S3 state bucket;
2. provisions networking, RDS, secrets, ECR, CodeBuild, ECS, API Gateway, and
   logging;
3. generates secrets outside Terraform state;
4. builds and pushes the exact current commit in CodeBuild;
5. runs the migration task before enabling the API service; and
6. forces a fresh ECS rollout so updated secret values are loaded; and
7. verifies health, readiness, invalid Google identity, and malformed refresh
   and logout behavior through the public HTTPS endpoint.

The script intentionally scales staging to zero during migration. Production
must use a separately reviewed expand/migrate/contract rollout.
