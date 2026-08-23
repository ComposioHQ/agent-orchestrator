# Cloud compute plane

The compute plane provisions and reclaims the isolated sandboxes that host AO
Cloud's workspace coordinators and worker agents. It lives in
`backend/internal/cloud/runtime` with the scoped credential authority in
`backend/internal/cloud/capability`.

It is library code. Nothing here is mounted or scheduled yet; see
[Wiring](#wiring) for what a deployment must assemble.

## What it does and does not own

Owned:

- sandbox lifecycle: idempotent create, start, stop, and cascade delete;
- per-org, per-user, and per-workspace quotas with a typed error;
- a reconciler that converges control-plane state and provider state in both
  directions, including orphan and leak cleanup;
- opaque, scoped, revocable capabilities and the published listener sandboxes
  present them on;
- the Daytona adapter.

Not owned, on purpose:

- durable product state. Projects, sessions, prompts, PR facts, and lifecycle
  history live in PostgreSQL. A sandbox holds a checkout, caches, and live
  processes; losing or reaping one loses nothing else.
- persistence. Both the placement store and the capability store are narrow
  consumer-owned interfaces. The package imports no database driver.

## Isolation model

A workspace's coordinator and each of its workers get **separate sandboxes with
separate capabilities**. The operation allow-lists are complements:

| Role | May | May not |
| --- | --- | --- |
| coordinator | heartbeat, report state, rotate, read its workspace, request worker sandboxes | read or write any session |
| worker | heartbeat, report state, rotate, read and write **its own** session | enumerate the workspace, request compute |

A compromised worker therefore cannot fan out, and a compromised coordinator
cannot read a session's contents.

## Capabilities

A capability is opaque: `aocap_v1.<grant id>.<secret>`. The store keeps only a
one-way verifier digest bound to the grant id **and** the scope fingerprint, so
a verifier lifted onto another row, or a row whose scope was widened, stops
matching. This is the local daemon's browser-capability pattern
(`internal/service/browser.Authority` plus `session_manager`'s
`launchRuntimeEnv` / `persistBrowserCapabilityVerifier`) with two additions a
hosted control plane needs: scoping and revocation.

- **Issuance** happens exactly when a sandbox is created or booted — the only
  moments it can receive a credential. Attaching to an already-running sandbox
  mints nothing.
- **Rotation** preserves the original absolute expiry, so a compromised sandbox
  cannot extend its own access by rotating on a timer.
- **Revocation** is idempotent and can select a session, a workspace, or an
  organization. Stopping a sandbox revokes; deleting revokes first, before
  anything else.

The credential is injected through the sandbox environment. `CreateRequest`
validation mechanically rejects any request whose entrypoint contains a secret
value: argv is readable by every process in the sandbox and lands in provider
audit logs. Secret files are written owner-only (0600).

## Lifecycle ordering

The load-bearing rule is:

> The placement row is written **before** the provider is contacted, and
> deleted **after** the provider confirms removal.

Consequences:

- A crash between the row insert and the provider call leaves a row with no
  sandbox. `Ensure` resumes it; the reconciler reclaims it after
  `AO_CLOUD_SANDBOX_PROVISIONING_TIMEOUT`.
- A lost create response leaves a fully labelled sandbox with no row. The
  reconciler attributes it and deletes it after `AO_CLOUD_SANDBOX_ORPHAN_GRACE`
  — never an untracked sandbox.
- Delete records `deleting` on the row first, then tears down in
  credential-first order: **capabilities → secrets → routes → provider → row**.
  A sandbox that survives a failed provider call can no longer act, and any
  failure leaves a resumable intent the reconciler finishes.

## Quotas

Counted over live (non-deleting) placements:

| Limit | Scope |
| --- | --- |
| `AO_CLOUD_MAX_SANDBOXES_PER_ORG` | organization |
| `AO_CLOUD_MAX_SANDBOXES_PER_USER` | user, so one member cannot consume a shared org limit |
| `AO_CLOUD_MAX_WORKERS_PER_WORKSPACE` | workspace fan-out |
| `AO_CLOUD_MAX_COORDINATORS_PER_WORKSPACE` | normally 1 |

Zero means unbounded, which is why the defaults are non-zero: opting out has to
be deliberate. Exceeding a limit returns a `*runtime.QuotaError` naming the
scope, resource, subject, limit, and current usage, and matching
`errors.Is(err, runtime.ErrQuotaExceeded)`.

The check is advisory, not a reservation: two concurrent creates can both
observe limit-1. Serializing every create behind a tenant lock is a worse trade
than occasionally running one sandbox over a soft limit; a hard cap belongs in
the provider account.

## Reconciliation

One pass, both directions.

Control plane → provider, per placement row:

| Situation | Action |
| --- | --- |
| row in `deleting` | resume the cascade |
| no provider id, still `provisioning`, past the timeout | delete the row and reclaim its quota |
| recorded state disagrees with the provider | repair the row (the provider is the authority) |
| desired `stopped`, provider running | stop it again |
| running and quiet past the idle timeout | stop, revoking the capability, keeping the disk |
| quiet past the abandoned timeout | full cascade delete |
| sandbox missing at the provider | mark failed so the next `Ensure` re-provisions the same row, or delete it if also abandoned |

Idleness is measured from the last authenticated heartbeat, falling back to the
row's creation time. That fallback is deliberate: a sandbox provisioned for a
session nobody ever attached to is the most expensive failure mode.

Provider → control plane, per sandbox in the account:

| Situation | Action |
| --- | --- |
| claimed by a row | leave alone |
| carries another deployment's `ao.deployment` label | leave alone (staging and production may share an account) |
| carries this deployment's labels, claimed by no row | re-read the row it names; if it still does not claim it, delete after the orphan grace |
| no usable AO attribution | report; delete only when `AO_CLOUD_REAP_UNLABELED_SANDBOXES` is on and past the grace |
| creation time unknown | never delete |

Unlabelled reaping is opt-in because the rule that catches a leak — "delete
what cannot be attributed" — would also delete a stranger's sandbox in a shared
provider account.

Per-item failures are collected into the report and the pass continues, so one
wedged sandbox cannot stop the fleet being reconciled. Alert on
`len(report.Errors)` staying non-zero across passes.

## Provider labels

Applied atomically at creation, never afterwards:

| Label | Purpose |
| --- | --- |
| `ao.managed` | marks the sandbox as AO-created |
| `ao.deployment` | which control plane owns it |
| `ao.org`, `ao.workspace`, `ao.session` | tenant attribution |
| `ao.role` | `coordinator` or `worker` |
| `ao.runtime` | the placement row id, which makes orphan detection exact |

A sandbox missing any of them is unattributable, which is the definition of a
leak.

## Published listener

`backend/internal/cloud/runtime/sandboxapi` serves three routes under
`/api/cloud/v1/sandbox`: `POST /heartbeat`, `POST /state`, and
`POST /capability/rotate`.

It is a separate surface from the account API because sandboxes hold a
capability, not an AO user access token, and one middleware choosing between
two credential classes is a branch that eventually authorizes the wrong one.
Every tenant identifier comes from the verified scope; nothing in a request
body selects an organization, workspace, or session. Each route pins exactly
one operation.

Heartbeat returns the desired state — how a sandbox learns about a pending stop
without a held-open connection — and the capability's expiry, so a long-lived
sandbox rotates ahead of time instead of meeting a 401 mid-turn.

## Configuration

```bash
export AO_CLOUD_COMPUTE_ENABLED=true
export AO_CLOUD_DEPLOYMENT=staging                     # stamped on every sandbox
export AO_CLOUD_PUBLIC_URL=https://cloud.example       # https, except loopback
export AO_CLOUD_DAYTONA_API_KEY_FILE=/run/secrets/daytona   # 0600, checked at startup
export AO_CLOUD_COORDINATOR_SNAPSHOT=ao-coordinator
export AO_CLOUD_WORKER_SNAPSHOT=ao-worker
```

Optional: `AO_CLOUD_DAYTONA_API_URL`, `AO_CLOUD_DAYTONA_ORGANIZATION_ID`,
`AO_CLOUD_DAYTONA_TARGET`, `AO_CLOUD_SANDBOX_{CPU,MEMORY_GB,DISK_GB}`,
`AO_CLOUD_SANDBOX_{AUTO_STOP,AUTO_DELETE}`, `AO_CLOUD_CAPABILITY_TTL`,
`AO_CLOUD_CAPABILITY_RETENTION`, the four quota variables, and
`AO_CLOUD_REAPER_INTERVAL`,
`AO_CLOUD_SANDBOX_{IDLE,ABANDONED,PROVISIONING}_TIMEOUT`,
`AO_CLOUD_SANDBOX_{ORPHAN,UNLABELED}_GRACE`,
`AO_CLOUD_REAP_UNLABELED_SANDBOXES`.

`AO_CLOUD_DAYTONA_API_KEY` is accepted directly, but the `_FILE` form is
preferred: the file's permissions are verified at startup, which is the only
moment an operator notices a world-readable credential.

`AO_CLOUD_SANDBOX_AUTO_STOP` and `AO_CLOUD_SANDBOX_AUTO_DELETE` ask Daytona for
its own idle guards. They are belt and braces behind the reaper: if this
control plane is down, the provider still stops paying for idle compute.

## Wiring

A deployment assembles the plane itself; the packages have no init-time state.

```go
cfg, err := runtime.LoadConfig(os.Getenv)
authority, err := capability.New(capabilityStore, cfg.CapabilityTTL)
provider, err := daytona.New(daytona.Options{
    BaseURL:        cfg.Daytona.BaseURL,
    APIKey:         cfg.Daytona.APIKey,
    OrganizationID: cfg.Daytona.OrganizationID,
    Target:         cfg.Daytona.Target,
})
manager, err := runtime.NewManager(runtime.Options{
    Store: placementStore, Provider: provider, Capabilities: authority,
    Deployment: cfg.Deployment, PublicURL: cfg.PublicURL,
    Snapshots: cfg.Snapshots(), Resources: cfg.Resources,
    CapabilityTTL: cfg.CapabilityTTL, Quotas: cfg.Quotas,
    AutoStopInterval: cfg.AutoStopInterval, AutoDeleteInterval: cfg.AutoDeleteInterval,
})
reaper, err := runtime.NewReaper(manager, authority, cfg.Reaper)
go reaper.RunLoop(ctx, cfg.ReaperInterval)

listener, err := sandboxapi.New(sandboxapi.Options{
    Compute: manager, Capabilities: authority, Rotator: authority,
})
// Mount listener.Handler() on the PUBLIC surface, at sandboxapi.BasePath.
// It must not sit behind the account API's user-token middleware.
```

### Store adapters

`runtimetest.MemoryStore` and `capability.MemoryStore` are the reference
implementations. A PostgreSQL adapter proves it matches by passing the same
conformance suites they do — `runtimetest.RunStoreConformance` and
`capabilitytest.RunStoreConformance` — rather than being reviewed by eye:

- `Ensure` never resurrects a row in `deleting`; it returns `created=false`.
- `Save` is generation-checked and returns `ErrConflict` on a stale generation.
- `Delete` refuses a stale generation and succeeds when the row is already gone.
- `Count` supports quota checks without paging a tenant into memory.
- Capability `Revoke` keeps the first revocation instant; `DeleteExpired`
  retains revoked rows until the retention cutoff.

The placement schema (`ao_cloud_session_runtimes`) needs `role`, `user_id`,
`desired_state`, and `last_heartbeat_at` columns and `deleting` added to its
state constraint, plus a capability-grant table. Those migrations are not in
this package.
