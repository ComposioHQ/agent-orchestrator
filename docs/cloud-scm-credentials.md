# Cloud SCM credential boundary

How the hosted control plane gives a tenant sandbox access to a Git repository
without ever holding, or handing out, a broadly scoped credential.

Code: `backend/internal/cloud/scm` (including its own HTTP routes and
environment surface), `backend/internal/cloud/postgres/scm_store.go`,
migrations `00030`/`00031`.

The slice owns nothing outside itself. It does not edit the shared control-plane
config or the control-plane router: it exposes `scm.LoadConfig` for its own
environment and `Routes.MountRoutes` for the composition to register, so
authentication and tenant resolution stay in one place rather than being
reimplemented here.

## The rules this boundary exists to enforce

1. **No shared operator token.** Every credential is minted from a GitHub App
   installation that the tenant organization linked itself. AO never holds a
   personal access token that spans tenants.
2. **Repository-scoped and short-lived.** A minted token names exactly one
   repository id and one permission set, and expires on GitHub's own clock
   (one hour).
3. **Default-deny allowlist.** An installation seeing a repository does not
   mean AO may clone or push it. An org admin allowlists it first.
4. **Webhooks can only narrow.** A signed delivery may suspend an installation
   or drop a repository. Nothing a webhook can say marks a repository allowed.
5. **Nothing durable in the sandbox.** The token reaches the sandbox through
   the compute plane's bootstrap channel, never argv, and the compute plane
   deletes and zeroes it as soon as the clone finishes.
6. **No secrets in logs or error envelopes.** Token material is wrapped in
   `scm.Secret`, which redacts under `fmt`, `encoding/json`, and `log/slog`.
   Provider response bodies and database constraint names never reach a client.

## Flow

### Linking an installation

1. `POST /api/cloud/v1/scm/github/installations` (authenticated, org admin)
   mints a 32-byte random state, stores only its SHA-256 digest bound to
   `(org, user)` with a 15-minute expiry, and returns GitHub's install URL.
   RLS rejects the state insert if the caller cannot manage the organization,
   so authorization is enforced in the database, not only in the handler.
2. The user installs the app. GitHub redirects to the app's **Setup URL**,
   `GET /api/cloud/v1/scm/github/setup`, with `installation_id`, `state`, and —
   when the app requests user authorization during installation — `code`.
3. The callback is unauthenticated by design: no AO bearer token survives a
   browser redirect. Three independent checks gate it:
   - the state must be an unconsumed, unexpired token this deployment issued
     (single-use; consumption is a `SECURITY DEFINER` delete);
   - the installation must exist according to an app-level JWT signed with the
     app private key;
   - when `AO_CLOUD_GITHUB_APP_CLIENT_ID`/`_CLIENT_SECRET` are configured, the
     one-time OAuth code must exchange for a user token that can see that
     installation. The user token is used for this check and discarded.
4. The installation is upserted under the state's organization. A unique
   constraint on `(provider, external_installation_id)` means an installation
   already linked elsewhere conflicts instead of being repointed.
5. Repositories are synchronized. If the user chose **specific repositories**
   during installation, that selection is itself the allowlist act and those
   repositories land allowed. An **all repositories** installation lands fully
   denied and requires an explicit allowlist call.

### Brokering a credential

`Broker.BrokerToken(ctx, BrokerRequest{OrgID, UserID, Repository, Purpose, WorkspaceID, SandboxID})`,
reached through `IssueCloneCredential`/`IssuePushCredential`:

1. Resolve the repository through RLS. `AllowedSCMRepository` returns
   `ErrNotFound` for both "unknown" and "known but denied", so a caller cannot
   probe an organization's repository inventory.
2. Refuse if the installation is suspended or removed.
3. Mint via `POST /app/installations/{id}/access_tokens` with
   `repository_ids: [id]` and the purpose's permissions:

   | Purpose | Permissions |
   | --- | --- |
   | `clone` | `contents: read`, `metadata: read` |
   | `push` | `contents: write`, `metadata: read`, `pull_requests: write` |
   | `observe` | `contents/metadata/pull_requests/checks: read` |

   A clone credential deliberately cannot push. Pushing requires a separate
   re-broker, which is a separate audited event.
4. Append to `ao_scm_token_grants`, recording the workspace and the sandbox
   that received it. If the ledger write fails the credential is discarded and
   the call errors: an unaccountable credential is worse than a failed
   bootstrap.
5. Cache read credentials in memory only, keyed by
   `(installation, repository, purpose)`, and stop serving them five minutes
   before expiry. Write credentials are never cached.

The identity is the workspace owner resolved from durable state, so a re-broker
for a background push does not require the user to be online.

### Delivering it to a sandbox

The compute plane consumes `scm.CredentialIssuer`:

```go
IssueCloneCredential(ctx, identity tenant.Identity, repoURL, sandboxID string) (Credential, error)
IssuePushCredential (ctx, identity tenant.Identity, repoURL, sandboxID string) (Credential, error)

type Credential struct {
    Username   string    // always x-access-token
    Token      []byte
    ExpiresAt  time.Time
    Repository string
}
```

`Token` is a byte slice, not a string, so the compute plane can erase it:
`Credential.Zero()` overwrites the backing array in place. A Go string is
immutable, so a leaked copy would survive until the collector happened to
reclaim it.

The compute plane owns what happens inside the sandbox. The agreed handling is:
write the credential 0600 as an askpass file, clone, then delete and zero it.
The token is never placed on argv — `/proc/<pid>/cmdline` is world-readable
inside a container — and never written to `.git/config`, `~/.git-credentials`,
or the agent's environment.

Pushing is a separate, on-demand act. A bootstrap credential is read-only, so a
sandbox that never legitimately pushes has no write capability at all; a
session-scoped helper calls `IssuePushCredential` over the authenticated
runtime listener when a push is actually needed. Write credentials are never
cached in the control plane either — a push is two audited mints, not one
long-lived token.

### Webhooks

`POST /api/cloud/v1/scm/github/webhook`. Unauthenticated at the bearer layer
only — HMAC verification and delivery-id idempotency are mandatory and happen
before the body is parsed. Order matters and is fixed:

1. HMAC-SHA256 over the raw body against `X-Hub-Signature-256`, constant time.
   A body that fails verification never reaches the JSON decoder or the
   database.
2. `X-GitHub-Delivery` dedup through `ao_scm_record_webhook_delivery`, which
   returns true only for the first sighting. Every side effect is gated on it,
   so GitHub's retries are harmless. A duplicate answers `200` so retries stop.
3. Installation lifecycle (`suspend`, `unsuspend`, `deleted`) and repository
   add/remove are applied through `SECURITY DEFINER` functions owned by
   `ao_cloud_scm`. The add function hard-codes `allowed = FALSE` and has no
   parameter that could set it otherwise.
4. PR-shaped events produce an `SCMObservationSignal` — repository, PR number,
   head SHA — and nothing else. The observer re-reads authoritative state
   through an installation token, so a forged-but-signed delivery cannot inject
   facts.

### Reusing the existing observer

`scm.NewObservationProvider` returns the ordinary
`adapters/scm/github.Provider` with an `InstallationTokenSource` in place of a
user token, so the hosted path reuses the same observation and attribution
logic as local AO.

The one override is identity. An installation token cannot read `/user`;
GitHub attributes its actions to the app's bot account. `AuthenticatedIdentity`
therefore returns `<app-slug>[bot]` with `Human: false`, which is what
attribution logic must compare against.

## Database

Migration `00030` — `ao_scm_installations`, `ao_scm_repositories` (the
allowlist), `ao_scm_install_states`, `ao_scm_token_grants`. All forced RLS,
org-scoped: members read, admins write.

Migration `00031` — `ao_scm_webhook_deliveries` plus the `ao_cloud_scm` NOLOGIN
role, mirroring the `ao_cloud_auth` pattern from `00006`. Webhook ingest and
install-callback completion have no authenticated principal and so cannot rely
on the `ao.user_id`/`ao.org_id` RLS context; they run as narrowly scoped
definer functions instead of widening the runtime role.

Two subtleties worth remembering:

- Postgres checks EXECUTE permission on **every** policy expression it plans,
  not only the one that decides the row. `ao_cloud_scm` therefore needs EXECUTE
  on `ao_is_org_member`/`ao_can_manage_org` even though its own policy never
  calls them.
- Foreign keys are validated with RLS bypassed. `ao_scm_token_grants_insert`
  re-proves that the installation, repository, and workspace it names all
  belong to the writing organization; without that a tenant could append audit
  rows referencing another tenant's installation.

## Configuration and mounting

`scm.LoadConfig` reads this slice's own environment. The whole group is
optional: absent, the routes are never mounted rather than existing
half-configured. Partial configuration fails at startup.

The three credential values arrive as one Secrets Manager document in
`AO_CLOUD_SCM_GITHUB_SECRET`. Its field names are the deployment contract:

```json
{
  "githubAppId": 4242,
  "githubAppPrivateKeyBase64": "<base64 PEM>",
  "githubWebhookSecret": "<hmac secret>"
}
```

The same three values may instead be injected individually as
`AO_CLOUD_GITHUB_APP_ID`, `AO_CLOUD_GITHUB_APP_PRIVATE_KEY_BASE64`, and
`AO_CLOUD_GITHUB_APP_WEBHOOK_SECRET`; the secret document wins when both are
present. Nothing here reads a key from a file path.

| Variable | Meaning |
| --- | --- |
| `AO_CLOUD_GITHUB_APP_SLUG` | App slug; also derives the bot login |
| `AO_CLOUD_GITHUB_APP_CLIENT_ID` / `_CLIENT_SECRET` | Enables user-authorization on install completion |
| `AO_CLOUD_GITHUB_APP_INSTALL_COMPLETION_URL` | Post-callback redirect; empty answers JSON |
| `AO_CLOUD_GITHUB_API_BASE` / `_WEB_BASE` | Overrides for tests and Enterprise |

Composition is two calls:

```go
bundle, err := scm.NewBundleFromEnv(store, sink, logger)
if errors.Is(err, scm.ErrNotConfigured) {
    // cloud SCM is off for this deployment; do not mount
} else if err != nil {
    return err // a real misconfiguration
}
err = bundle.Routes.MountRoutes(router, scm.MountDeps{
    RequireTenant: requirePrincipalAndTenant, // the composition's own chain
    RateLimit:     authRateLimit,
})
```

`bundle.Broker` is the `scm.CredentialIssuer` the compute plane consumes.

`MountDeps.RequireTenant` must authenticate the bearer token and put a
`tenant.Identity` on the request context. The SCM handlers read the acting
organization from there and nowhere else — there is no `orgId` request field,
so a client cannot name a different organization per call.

## Residual risks

- **The app private key is the root of trust.** Anyone holding it can mint a
  token for any installation of the app. It lives only in Secrets Manager and
  process memory, and is never logged, persisted, or echoed in an error.
- **The in-memory broker cache** holds live read tokens for up to 55 minutes.
  A control-plane memory disclosure exposes them; they remain repository-scoped,
  read-only, and expire on GitHub's clock. Write tokens are not cached.
- **Install-callback binding relies on the state token** when user
  authorization is not configured. Configure `_CLIENT_ID`/`_CLIENT_SECRET` in
  any deployment that matters — that is the check which stops someone who
  learns an installation id from attaching it to their own organization.
- **The webhook endpoint is publicly reachable.** Unsigned traffic is rejected
  before any work, but it is a reachable surface; keep it behind the same edge
  rate limiting as the auth routes.
