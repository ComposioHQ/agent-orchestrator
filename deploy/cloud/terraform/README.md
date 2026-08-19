# AO Cloud AWS stack

This stack bootstraps the hosted control plane described in
[`docs/cloud/deployment.md`](../../../docs/cloud/deployment.md). It deliberately
creates the ECS service at zero tasks. Run the migration-first release script,
then set `deployment_enabled = true` to install the two-task autoscaling floor.

Use encrypted remote state. Terraform state contains generated database and
signing credentials. A populated tfvars file, Terraform state, Google token,
Daytona key, or GitHub private key must never be committed.
