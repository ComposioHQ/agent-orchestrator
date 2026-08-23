# `@aoagents/cloud-client`

Runtime-neutral TypeScript client for the AO Cloud control plane.

This package intentionally contains no product application routes or DTOs. The
separate code-first application specification and generated client own projects,
sessions, conversations, worktrees, and all other shared product operations.
Control-plane organization administration is always scoped by `orgId` in the
path and authorized against the authenticated principal's membership.

```ts
import { createCloudClient } from "@aoagents/cloud-client";

const cloud = createCloudClient({
  baseUrl: "https://cloud.example.com",
  getAccessToken: () => authSession.getAccessToken(),
});

const accepted = await cloud.createWorkspacePlacement(
  orgId,
  { displayName, repositoryUrl, defaultBranch },
  { idempotencyKey },
);
```

Workspace creation, deletion, and resume are asynchronous `202` operations.
Poll the returned workspace placement until it reaches `ready` or `failed`.
The placement carries the authoritative `defaultBranch`; project discovery
after readiness belongs to the separate application client.

Sandbox clients receive their scoped capability out of band in the fixed
`/run/ao/capability` file with mode `0600`. No Cloud API response returns or
rotates this bearer.

```ts
import { createWorkerClient } from "@aoagents/cloud-client";

const worker = createWorkerClient({
  baseUrl: controlPlaneUrl,
  getCapability: () => capabilityReadFromProtectedFile,
});

await worker.getStatus();
await worker.sendMessage(sessionId, { message }, { idempotencyKey });
```

Terminal tickets are issued from the organization/session control-plane route.
The response contains an absolute sandbox mux URL, an `ao.ticket.*` one-time
ticket, exact scopes, expiry, and the `ao.mux.v1` protocol. The sandbox redeems
the ticket atomically at the control plane; terminal bytes never traverse it.

Bootstrap and checkout APIs expose scoped delivery IDs and state only. Provider
credentials are accepted solely by organization vault administration and are
never exposed through worker credential or audit endpoints.

The source contract is `contracts/cloud/openapi.yaml`. Run `npm run generate`
in this package after changing it and commit the generated `src/schema.ts`.
