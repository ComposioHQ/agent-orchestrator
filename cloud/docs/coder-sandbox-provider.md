# Coder sandbox provider

AO Cloud can use a customer-operated Coder deployment as its sandbox compute
provider. AO creates one Coder workspace per AO session, installs `ao-worker`
through the workspace's existing `coder_agent`, and keeps the rest of the
session lifecycle behind the same provider-neutral reconciler used by NodeOps.

The first implementation is deployment-scoped: every AO organization on that
control plane uses the same Coder connection and approved template. It does not
yet decrypt a separate Coder connection per AO organization.

## Customer access required

Use a dedicated, ordinary Coder user such as `ao-integration`; do not grant it a
site-admin role. In Coder Community Edition, that user and its API token must be
able to:

- read the approved template and its active version;
- create workspaces owned by itself from that template;
- read, start, stop, and delete the workspaces it owns; and
- connect to the `coder_agent` terminal for those workspaces.

AO calls these Coder API surfaces:

| Operation | Coder API |
| --- | --- |
| Create | `POST /api/v2/users/{owner}/workspaces` |
| Inspect | `GET /api/v2/workspaces/{id}` |
| Recover by AO session | `GET /api/v2/users/{owner}/workspace/{name}` |
| Start, stop, delete | `POST /api/v2/workspaces/{id}/builds` |
| Install or repair worker | `GET /api/v2/workspaceagents/{agent}/pty` (WebSocket) |

For a quick Community Edition pilot, an API token with `coder:all` is bounded by
the permissions of this ordinary user and is the simplest setup. On Coder
versions that support composite API-token scopes, the narrower set AO needs is
`coder:workspaces.create`, `coder:workspaces.operate`,
`coder:workspaces.delete`, and `coder:workspaces.access`.

The service plane needs HTTPS and WebSocket connectivity to the Coder URL.
Workspaces need outbound HTTPS connectivity to `AO_CLOUD_PUBLIC_URL`; neither
Coder nor the workspace needs inbound connectivity from the AO desktop app.

## Template contract

The approved template must create a Linux workspace with at least one
`coder_agent`. The normal workspace user must have passwordless `sudo` for the
pilot bootstrap. AO uses it to:

- create the unprivileged `ao-worker` OS user;
- install the release-pinned `ao-worker` and AO helper binaries under
  `/usr/local/bin`;
- create and assign `/workspace` to the worker user; and
- launch the worker, which then dials the AO service plane and sends its own
  heartbeats.

The template is also responsible for the tools an AO task uses: `git`, CA
certificates, and the selected coding-agent harness CLI (for example Claude
Code or Codex). Those tools are baked into AO's NodeOps image today; the Coder
provider deliberately does not mutate a customer's template by installing
third-party harnesses at session startup.

No worker credential is placed in the PTY URL or command. AO streams a private
archive over terminal input, writes the launch environment with mode `0600`,
and deletes that environment file when the worker starts.

For a production rollout, prefer baking the OS user and directories into the
template or a narrowly scoped install helper over unrestricted passwordless
`sudo`. The provider can then be tightened to that contract without changing
the lifecycle API.

## Configuration

Set:

```text
AO_CLOUD_SANDBOX_PROVIDER=coder
AO_CLOUD_CODER_URL=https://coder.customer.example
AO_CLOUD_CODER_TOKEN=<dedicated-user-api-token>
AO_CLOUD_CODER_OWNER=ao-integration
AO_CLOUD_CODER_TEMPLATE_ID=<approved-template-uuid>
AO_CLOUD_CODER_AGENT_NAME=<optional-agent-name>
AO_CLOUD_CODER_PARAMETERS_JSON={"instance_type":"t3.medium","region":"us-west-2"}
AO_CLOUD_CODER_WORKER_TOKEN_TTL=15m
```

The ordinary AO worker settings remain required:

```text
AO_CLOUD_PUBLIC_URL=https://api.example.com
AO_CLOUD_WORKER_SIGNING_KEY=<at-least-32-characters>
AO_CLOUD_WORKER_BINARY_PATH=/opt/ao/bin/ao-worker
AO_CLOUD_WORKER_HELPER_BINARY_PATH=/opt/ao/bin/ao
```

Keep `AO_CLOUD_CODER_TOKEN` in the service plane's secret manager. Do not put it
in the desktop app, a workspace environment variable, or AO's provider plan.

For the AWS ECS deployment scripts, store those values in the environment's
Secrets Manager JSON document (`ao-cloud/staging/coder` or
`ao-cloud/production/coder`) using these keys:

```json
{
  "url": "https://coder.customer.example",
  "token": "<dedicated-user-api-token>",
  "owner": "ao-integration",
  "template_id": "<approved-template-uuid>",
  "agent_name": "",
  "parameters_json": "{}",
  "worker_token_ttl": "15m"
}
```

Grant the environment's ECS execution role `secretsmanager:GetSecretValue` on
that secret, then deploy staging with `AO_CLOUD_SANDBOX_PROVIDER=coder`. The
task-definition renderer removes stale NodeOps values when switching providers.
