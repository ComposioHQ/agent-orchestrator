# `@aoagents/cloud-client`

Runtime-neutral TypeScript contracts and a small fetch-based client for AO
Cloud's control plane plus the shared project/session routes a hosted client
uses. Shared operations stay at `/api/v1`; authentication, project placement,
terminal tickets, SCM installation, credentials, and worker compute concerns
remain under their control-plane routes.

The `App*` types are exact, namespaced copies of the generated daemon DTOs. A
backend parity test compares every copied operation and schema to
`backend/internal/httpd/apispec/openapi.yaml`, so Cloud cannot silently grow a
second session or project shape.

The header name and its rule are exported so hosts do not drift to three
spellings of it:

```ts
import { organizationHeaders } from "@aoagents/cloud-client";

await fetch(`${appBaseUrl}/api/v1/sessions`, {
  headers: { ...authHeaders, ...organizationHeaders(activeOrg?.id) },
});
```

`X-AO-Org` takes an organization id or slug — prefer the id, since a slug is
renameable. It is only required when the account belongs to more than one
organization: with a single active membership the server resolves it, and with
several, omitting it is an error rather than a guess. Sending it always is
harmless and is the simplest rule if you would rather not branch.

```ts
import { createCloudClient } from "@aoagents/cloud-client";

const cloud = createCloudClient({
  baseUrl: "https://cloud.example.com",
  getAccessToken: () => authSession.getAccessToken(),
  fetch,
});

const projects = await cloud.listAppProjects(orgId);
const sessions = await cloud.listSessions(orgId, { project: projectId });
```

The caller owns authentication and token refresh. `createCloudClient` asks for
an access token immediately before a user request. `createWorkerClient` does the
same for every authenticated worker request. It also exposes the unauthenticated
one-time bootstrap exchange:

```ts
import { createWorkerClient } from "@aoagents/cloud-client";

let workerToken: string | null = null;
const worker = createWorkerClient({
  baseUrl: "https://cloud.example.com",
  getWorkerToken: () => workerToken,
  fetch,
});

const bootstrap = await worker.bootstrap({
  bootstrapToken: oneTimeTicket,
  version: workerVersion,
  capabilities,
});
workerToken = bootstrap.workerToken;

const heartbeat = await worker.heartbeat({ version: workerVersion, capabilities });
workerToken = heartbeat.workerToken;
```

`createSandboxClient` is the narrower sandbox-to-control-plane client. It reads
the rotating sandbox capability immediately before consuming a terminal ticket;
the one-time terminal ticket itself remains in the JSON body.

## Attaching to a session terminal

The framing is the local daemon's terminal mux — same channels, same field
names — so an xterm client that already talks to a local daemon attaches to a
hosted session unchanged. Frames are `MuxClientFrame` / `MuxServerFrame`.

Attachment is a two-credential handoff. The bearer token proves who the caller
is to the control plane and never leaves it. The ticket is single-use,
short-lived and scope-bound, and it travels **as a WebSocket subprotocol** —
not in the URL, where it would reach proxy logs, browser history and referrers:

```ts
const ticket = await cloud.createTerminalTicket(orgId, sessionId, "agent", {
  scopes: ["terminal:read", "terminal:operate"],
});
const socket = new WebSocket(
  cloud.terminalUrl({ connection: ticket.connection, after: lastRenderedSeq }),
  cloud.terminalSubprotocols(ticket), // ["ao.mux.v1", "ao.ticket.<opaque>"]
);
```

The server authenticates from the ticket subprotocol and selects only
`ao.mux.v1`, so the credential is never echoed back. Close the socket if
anything else is selected rather than guessing a framing.

Never rebuild the attach URL from `baseUrl`: the listener may not share the
control plane's origin, which is why `connection.url` is reported.

`createTerminalTicket` grants the intersection of the scopes asked for and the
caller's authority, so check `ticket.scopes` for `terminal:operate` before
letting a user type — a read-only viewer should get a read-only terminal rather
than a rejected keystroke.

A `terminal`/`data` frame may carry an optional `seq`. Where the listener keeps
a replay buffer, reconnect with the last one rendered as `after` to replay the
gap; a local daemon keeps none, so the field is optional and the same client
code works against both.

Keep terminal tickets, bootstrap, worker, agent-credential, and checkout-grant
secrets only in memory and never log them. Secret-bearing client requests use `cache:
"no-store"`; the credential and checkout-grant responses also require the
server's `Cache-Control: no-store`.

The source contract is `contracts/cloud/openapi.yaml`. Run `npm run generate`
from this directory after changing it. The generated `src/schema.ts` file is
committed so consumers do not need an OpenAPI toolchain.
The worker client matches the control plane's bootstrap, heartbeat, event,
fenced turn, credential, checkout-grant, child orchestration, workspace
transport, and terminal transport routes. It intentionally excludes worker
provisioning, database details, secret storage, and local daemon routes.
