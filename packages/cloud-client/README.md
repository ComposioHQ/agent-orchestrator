# `@aoagents/cloud-client`

Runtime-neutral TypeScript client for AO Cloud.

Hosted product operations use the same `/api/v1` paths and generated DTOs as
the local AO application API. The client adds `X-AO-Org` to those authenticated
requests. Control-plane administration remains under `/api/cloud/v1`, with
`orgId` in the path; `X-AO-Org` is never sent as an alternate admin authority.

```ts
import { createCloudClient } from "@aoagents/cloud-client";

const cloud = createCloudClient({
  baseUrl: "https://cloud.example.com",
  getAccessToken: () => authSession.getAccessToken(),
});

const projects = await cloud.listProjects(orgId);
const placement = await cloud.createWorkspacePlacement(
  orgId,
  { displayName, repositoryUrl, defaultBranch },
  { idempotencyKey },
);
```

Project creation is asynchronous. Poll `getWorkspacePlacement` until its state
is `ready` or `failed`; after `ready`, discover the project through the shared
`/api/v1/projects` response. Placement status always carries the authoritative
`defaultBranch`.

Sandbox clients receive their scoped capability out of band in the fixed
`/run/ao/capability` file with mode `0600`. The runtime-neutral client accepts a
getter for that already-loaded value; no API response returns or rotates it.

```ts
import { createWorkerClient } from "@aoagents/cloud-client";

const worker = createWorkerClient({
  baseUrl: controlPlaneUrl,
  getCapability: () => capabilityReadFromProtectedFile,
});

await worker.getStatus();
await worker.sendSessionMessage(sessionId, { message }, { idempotencyKey });
```

Bootstrap and checkout methods exchange only scoped, one-shot delivery IDs and
delivery state. They never model credentials in JSON, argv, environment, or git
configuration. Terminal creation returns a one-time ticket and the authenticated
sandbox mux URL; there is no control-plane terminal relay.

The source contract is `contracts/cloud/openapi.yaml`. It references canonical
shared schemas from `backend/internal/httpd/apispec/openapi.yaml`. After either
contract changes, run `npm run generate` in this package and commit the generated
`src/schema.ts`.
