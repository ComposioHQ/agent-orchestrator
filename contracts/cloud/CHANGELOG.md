# Cloud contract changelog

Revisions to `contracts/cloud/openapi.yaml`, written for the sessions building
against it. Each entry states what moved and — where it matters — what a client
that already built against the previous revision has to change.

The **DTO deltas vs `/api/v1`** table is the part worth tracking: the desktop's
existing components read the local daemon's DTOs, and the Cloud contract keeps
those shapes so the components work unchanged for cloud projects. Every field
listed there is optional, and its local default is documented on the field
itself. Cloud-only fields (org, workspace, provider state) are optional too and
are simply absent for local AO.

Two conventions this file exists to keep visible:

- Defaults on **response** properties are documented in prose, never as a schema
  `default:`. `openapi-typescript` promotes a defaulted response property to a
  *required* one, which would defeat the point of adding it as optional.
- `backend/internal/cloud/httpapi/contract_parity_test.go` holds
  `stagedOperations`, the ledger of contracted-but-unbuilt routes. Adding an
  operation here means adding a line there; mounting its handler means deleting
  that line. The test fails in both directions.

## Unreleased — the product surface is `/api/v1`, not a copy of it here

Decided by the integrating session (140) on 2026-08-22, after the revision
below had already landed. Recorded here because it changes where work belongs,
and three sessions are building against this file.

**The hosted product API is the existing app API at `/api/v1`.** A hosted
deployment mounts those routes unchanged and scopes them with a header;
`/api/cloud/v1` keeps only what has no local equivalent — authentication and
organization administration. There is to be no second copy of the product
routes under `/api/cloud/v1`.

| Decision | Consequence here |
| --- | --- |
| App routes stay at `/api/v1` | Product operations under `/api/cloud/v1/orgs/{orgId}/...` are duplicates and are being reconciled. |
| `X-AO-Organization-ID` on hosted app routes, after bearer auth | New `OrganizationHeader` parameter. Middleware verifies an *active* membership and injects tenant context. |
| Project/session IDs stay in existing route/body fields | No org or workspace identifiers get pushed into app route paths; stores enforce workspace ownership. |
| Auth and org admin stay at `/api/cloud/v1` | Unchanged. |
| Terminal preserves `/mux` semantics where possible | The `ao.terminal.v1` framing below is **provisional**; see below. |

### Deprecated, not deleted

Three operations added in the revision below duplicate routes the app API
already serves. They now carry `deprecated: true`, so `openapi-typescript`
emits `@deprecated` and a consumer sees it in-editor; the client methods carry
the same marker. They still work — nothing breaks mid-flight.

| Deprecated | Superseded by |
| --- | --- |
| `getProject` | `GET /api/v1/projects/{id}` |
| `terminateSession` | `POST /api/v1/sessions/{sessionId}/kill` |
| `restoreSession` | `POST /api/v1/sessions/{sessionId}/restore` |

### Deliberately *not* deprecated

- `getSessionActivity` is only half-superseded. The app API's session record
  already carries `activity`, but no `/api/v1` route reports compute-plane
  lifecycle, because a local daemon has none. Deprecating it would leave
  sandbox state with no contract at all.
- `resumeProject` and `getTerminalConnection` have no `/api/v1` equivalent.
  Resuming a suspended workspace and learning which host to attach a terminal
  to are both concepts a local daemon does not have.

### Still open

The pre-existing `/api/cloud/v1/orgs/{orgId}/...` product routes — `listProjects`,
`createProject`, `updateProject`, `deleteProject`, `listSessions`,
`createSession`, `deleteSession`, `sendMessage`, `cancelTurn`, the event,
workspace, review and pull-request routes — predate this contract work and were
not asked about in the decision. Whether they move to `/api/v1`, or the rule is
only "add no new ones here", is unresolved and has been raised twice with the
integrator. **Nothing has been deleted pending that answer**: removing another
session's surface from a file four sessions consume is not a call to make on an
inference.

The terminal framing is provisional. `/mux` is the local daemon's multiplexed
WebSocket (`backend/internal/terminal/protocol.go`): one socket carrying
channel-tagged JSON frames, base64 payloads, `cols`/`rows`. What is specified
below is a *single-terminal* `ao.terminal.v1` framing, which is not that. If
preserving `/mux` semantics means literal parity so the existing xterm client
attaches unchanged, the framing gets rewritten. Held pending session 160's
protocol specifics, per the integrator. The reconnect cursor and capability
metadata survive either outcome — both were explicitly allowed.

## Unreleased — control-plane contract for projects, sessions, and terminals

Owner: session 163. Base: `3bd62e9f3`.

### Endpoints added

| Operation | Route | Notes |
| --- | --- | --- |
| `getProject` | `GET /orgs/{orgId}/projects/{projectId}` | Single-row refresh; the list already carries the same shape. |
| `resumeProject` | `POST /orgs/{orgId}/projects/{projectId}/resume` | 202, async. Brings a `suspended` workspace back. Idempotency-Key. |
| `terminateSession` | `POST /orgs/{orgId}/sessions/{sessionId}/terminate` | 202, async. The **reversible** stop, mirroring local `kill`. Idempotency-Key. |
| `restoreSession` | `POST /orgs/{orgId}/sessions/{sessionId}/restore` | 202, async. Idempotency-Key. |
| `getSessionActivity` | `GET /orgs/{orgId}/sessions/{sessionId}/activity` | Read-only snapshot. Sandbox transitions are not turn events, so they never reach the SSE stream. |
| `getTerminalConnection` | `GET /orgs/{orgId}/sessions/{sessionId}/terminal-connection` | Ticket-free discovery: where to attach, and whether there is anything to attach to. |

### Endpoints changed — action required

- `deleteProject` and `deleteSession` now **require** `Idempotency-Key`. Callers
  must pass one; the generated client signatures changed from optional request
  options to `IdempotentRequestOptions`.
- `deleteSession` is permanent and unrestorable. Use `terminateSession` for the
  reversible stop — the distinction is new, and a client that was calling
  `deleteSession` to mean "stop this" now wants `terminateSession`.
- `createTerminalTicket` accepts an optional requested `scopes` array and grants
  the intersection with the caller's authority. Check `ticket.scopes` for
  `terminal:operate` before letting a user type; a read-only viewer now gets a
  read-only terminal rather than a failed open.

### DTO deltas vs `/api/v1`

All optional. "Local" is what the field means for a local daemon project or
session, and is what a client should assume when the field is absent.

| DTO | Field | Purpose | Local |
| --- | --- | --- | --- |
| `Project` | `kind` | Matches the local project kind vocabulary. | `single_repo` |
| `Project` | `agent` | Default harness, named as the local field is. | org default |
| `Project` | `lifecycleState` | Cloud workspace lifecycle. | always `ready` |
| `Project` | `lifecycleMessage` | Operator detail for `error`. | absent |
| `Project` | `archivedAt` | Set once archived. | absent |
| `Session` | `activity` | Exactly the local `{state, lastActivityAt}` shape. | derive from `activityState` + `updatedAt` |
| `Session` | `interfaceMode` | The local session `mode` (`chat`/`tui`). **See the collision note below.** | `chat` |
| `Session` | `model` | Model the harness reports. | harness default |
| `Session` | `issueId` | Tracker issue this session was spawned for. | absent |
| `Session` | `isPinned`, `pinnedAt` | Board pinning. | `false` |
| `Session` | `terminateOnPrMerge` | Local merge policy field. | `false` |
| `Session` | `autoReviewEnabled` | Local auto-review field. | project setting |
| `Session` | `autoInjectReview`, `autoInjectCI` | Local auto-inject fields. | `false` |
| `Session` | `terminatedAt` | Set while `isTerminated`. | absent |
| `TerminalTicket` | `connection` | Where and how to attach. | n/a |
| `TerminalTicket` | `expiresAt`, `sessionId`, `kind`, `lastSequence` | Binding and replay cursor. | n/a |

`TerminalTicket`'s required set is unchanged, so the addition is backwards
compatible for anything already reading it.

#### Known collision: `Session.mode`

Local `/api/v1` `session.mode` is `chat|tui`. Cloud `Session.mode` already meant
the **permission** mode (`read-only|standard|trusted`) before this revision and
was not renamed. The local meaning is therefore carried as
`Session.interfaceMode`.

A mapper ported from local code must read `interfaceMode`, not `mode`. Renaming
Cloud's to `permissionMode` would remove the trap at the cost of breaking every
existing reader — open decision, not taken unilaterally.

#### Compute-plane state is not on the UI DTOs

Sandbox lifecycle is published only by `getSessionActivity`, never on `Session`
or `Project`. Those DTOs are what the desktop's existing components render, and
a session row should not have to know that a compute plane exists.

`SessionSandbox` is vendor-neutral by construction: no provider name, no
provider-assigned identifier, no region. A client renders and retries from
`state` alone, so adding or swapping a compute provider is invisible to every
client. `SandboxState` is AO's own abstraction, not a provider's vocabulary.

Both rules are enforced by `TestSandboxStateIsVendorNeutral` and
`TestUIDTOsOmitCloudOnlyPlacement`, so re-adding a `provider`, `region`, or
`workspaceId` field fails the build rather than quietly shipping.

#### Not carried over

`Session` has no `scmStatus`. Local carries it alongside `status`; the Cloud
`SessionStatus` enum already merges the SCM states into `status`.

### Schemas added

`ProjectKind`, `ProjectLifecycleState`, `ResumeProjectInput`,
`SessionInterfaceMode`, `SandboxState`, `SessionSandbox`, `SessionActivity`,
`TerminateSessionInput`, `RestoreSessionInput`, `TerminalTransport`,
`TerminalProtocol`, `TerminalFeature`, `TerminalConnection`,
`TerminalClientFrame` and `TerminalServerFrame` with their nine member frames.

### Terminal attachment

Previously the client-facing terminal WebSocket had a route and no framing at
all, and the client rebuilt its URL from the API base — which only holds while
the listener shares the control plane's origin.

- **Where.** `TerminalConnection.url` is an absolute attach URL the server
  reports. Do not rebuild it. An empty `kinds` means there is nothing to attach
  to yet, which is the normal answer while a sandbox provisions.
- **Auth.** Two credentials. The bearer token proves identity to the control
  plane and never leaves it; the ticket is single-use, short-lived, bound to
  session, kind and scopes, and is the only thing that travels to the listener,
  because a WebSocket handshake cannot carry headers.
- **Protocol.** Subprotocol `ao.terminal.v1`. JSON text frames discriminated by
  `type`, with base64 `data` and `columns`/`rows` matching the worker transport
  payloads so the compute plane forwards frames without re-encoding. Every
  `output` frame carries a monotonic `sequence`; reconnect with the last one
  rendered as `after`. The first server frame is always `ready`, and a
  `ready.sequence` below the requested `after` means the retained buffer no
  longer reaches the client's cursor — clear the screen rather than render a gap.

### Conventions documented

`info.description` now states the auth, tenant-scoping, error, pagination and
idempotency rules that were previously implicit in individual operations —
notably that the organization is in the path so a misrouted request fails loudly
instead of resolving against whichever tenant the token carried, and that `code`
rather than `message` is the value to branch on.
