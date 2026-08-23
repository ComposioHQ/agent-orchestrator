# `@aoagents/cloud-client`

Runtime-neutral TypeScript contracts and a small fetch-based client for AO
Cloud's **control plane**: authentication, organization administration, project
placement, terminal ticket minting, and GitHub App installation.

**This is not the product API.** Sessions, messages, events, pull requests,
reviews and workspace files all live on the app API at `/api/v1`, whose types
are generated into `frontend/src/api/schema.ts`. A hosted deployment serves
those same routes behind the bearer token, selecting the tenant with an
`X-AO-Org` header; the DTOs and controller semantics are identical to a local
daemon's, so a component that renders local AO renders hosted AO unchanged. Do
not reach for this package to read or mutate a session — it deliberately cannot.

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

const projects = await cloud.listProjects(orgId, { limit: 50 });
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

## Attaching to a session terminal

Terminal attachment is a two-credential handoff. The bearer token proves who the
caller is to the control plane and never leaves it; the ticket is a single-use,
short-lived, scope-bound credential that travels to the terminal listener in the
WebSocket URL, because a browser cannot set headers on a handshake.

The listener is not necessarily the API origin, so never rebuild the attach URL
from `baseUrl` — use the connection the server reported:

```ts
const ticket = await cloud.createTerminalTicket(orgId, sessionId, "agent", {
  scopes: ["terminal:read", "terminal:operate"],
});
const socket = new WebSocket(
  cloud.terminalUrlForTicket(ticket, { after: lastRenderedSequence }),
  ticket.connection?.protocol ?? "ao.terminal.v1",
);
```

`createTerminalTicket` grants the intersection of the scopes asked for and the
caller's authority, so check `ticket.scopes` for `terminal:operate` before
letting the user type. Call The ticket carries a `connection`
describing where and how to attach, so minting and connecting is one round trip.

Frames are JSON text messages discriminated by `type` (`TerminalClientFrame` and
`TerminalServerFrame`), with byte payloads base64-encoded in `data`. Every
`output` frame carries a monotonic `sequence`; reconnect with the last one
rendered as `after` to replay the gap. The first server frame is always `ready`,
and a `ready.sequence` lower than the requested `after` means the retained buffer
no longer reaches your cursor — clear the screen rather than render a gap.

Keep terminal tickets, bootstrap, worker, agent-credential, and checkout-grant
secrets only in memory and never log them. Secret-bearing client requests use `cache:
"no-store"`; the credential and checkout-grant responses also require the
server's `Cache-Control: no-store`.

The source contract is `contracts/cloud/openapi.yaml`. Run `npm run generate`
from this directory after changing it. The generated `src/schema.ts` file is
committed so consumers do not need an OpenAPI toolchain.
`contracts/cloud/CHANGELOG.md` tracks each revision and the DTO deltas against
the local daemon's `/api/v1` shapes — read it before adapting to a new one.

The worker client matches the control plane's bootstrap, heartbeat, event,
fenced turn, credential, checkout-grant, child orchestration, workspace
transport, and terminal transport routes. It intentionally excludes worker
provisioning, database details, secret storage, and local daemon routes.
