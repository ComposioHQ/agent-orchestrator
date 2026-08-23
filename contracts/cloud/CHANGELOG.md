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
| `Project` | `workspaceId` | Cloud workspace backing the project. | absent |
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
| `Session` | `workspaceId` | Cloud workspace of the sandbox. | absent |
| `Session` | `sandbox` | Compute-plane state. | absent — local sessions are processes, not sandboxes |
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
