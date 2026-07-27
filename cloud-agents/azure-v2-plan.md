# Azure + Daytona — Cloud Agents v2 Plan

**Status:** Plan (v2 = v1 verbatim + added detail on harnesses, domain, and server). Supersedes `azure-v1-plan.md` and `hybrid-cloud-agents.md`.
**Scope:** Single operator, pure-cloud execution. Prove the cloud-agent loop with the least moving parts.

> v2 is v1 with **nothing removed** — the phases, decisions, and deferrals below are identical to v1. v2 only **adds** three detail sections at the end (Appendix A — harnesses & auth, Appendix B — domain, Appendix C — server), reflecting decisions made after v1: **bake all 23 harness binaries into the image and expose a wide env-var surface where the user sets whatever key(s) they have.**

---

## Architecture at a glance

```
Electron app (laptop) ──https + token──► Coordinator (Azure VM) ──Daytona API──► agent sandboxes (Daytona)
                                          bare `ao` binary + SQLite                 │ git push
                                                                                    ▼
                                                                                  GitHub
```

**Three components, and how each is packaged:**

| Component | Where | Packaged as | Needs an image? |
| :--- | :--- | :--- | :--- |
| **Coordinator** | Azure VM | bare `ao` Go binary + systemd | **No** — Docker dropped (single static CGO-free binary) |
| **Sandbox** (agent runs here) | Daytona | a Daytona/OCI **image** | **Yes** — the only image in v1 |
| **Electron app** | laptop | the desktop app | **No** |

**Pure cloud:** every agent runs in a Daytona sandbox. There is no laptop-local execution in v1; the Electron app is purely a client.

---

## Key decisions

- **Coordinator always on an Azure VM**, run as a **bare `ao daemon` binary under systemd** (no Docker — nothing to package for a static Go binary).
- **SQLite** on the VM (`~/.ao/data/ao.db`). **No backup in v1** — Azure managed disks are already replicated, and a DB loss costs history/metadata, not the code (in GitHub). Postgres + off-box backup deferred.
- **Sandboxes on Daytona** (pure cloud). Implement `RemoteRuntime`/`RemoteWorkspace` + a thin `ports.SandboxProvider` against Daytona's SDK. Reuse existing `ports.Runtime`/`ports.Workspace`; `Manager.Spawn` untouched.
- **Auto-deploy via a cron job that builds on the VM** (not GitHub Actions), with a health-check + rollback, from a `release` branch/tag.
- **Client connection = `--server` mode + shared token + Caddy TLS.** No app auth in v1 (the token is the gate); email/Google OIDC is a later milestone.
- **Deferred:** conversation persistence, queue/autoscaling, Postgres, real auth, Tailscale, laptop-local execution, mid-session local↔cloud switching.

---

## Phase A — Prep

1. `az login`; confirm Azure credits.
2. **Daytona** account + **API key**.
3. **Decide the sandbox image contents** (see note below, and **Appendix A** for the concrete v2 list).

> ### What "sandbox image contents" means
> Each cloud agent runs in a disposable Daytona **sandbox**, created from a **template = the image**. "Pick the contents" = decide what's pre-installed so the agent is ready to work the moment the sandbox boots:
> - **Base OS** (e.g. Ubuntu),
> - **git** (clone/commit/push),
> - **the agent CLI** (the AI program that does the work, e.g. Claude Code),
> - **project toolchains** the agent needs to run the code (Node/npm, Python, Go, …), plus `tmux`/`curl`.
>
> **Not** baked into the image: **secrets** (GitHub token, model API key — injected at runtime) and **the repo code** (cloned at runtime via git).
>
> This image is **only for Daytona sandboxes.** The coordinator is a bare binary (no image); the Electron app is just the app.

---

## Phase B — Coordinator on the VM *(infra)*

5. `az vm create -g ao-rg -n ao-coordinator --image Ubuntu2204 --size Standard_B2s --generate-ssh-keys --public-ip-sku Standard`.
6. Install **Go** on the VM; `git clone` the repo to `/opt/ao/agent-orchestrator`.
7. `ao.service` systemd unit → `ao daemon`, `Restart=always`, `EnvironmentFile=/opt/ao/.env` (`DAYTONA_API_KEY`, `GITHUB_TOKEN`, model key, `AO_AUTH_TOKEN`), `HOME=/home/azureuser`. `systemctl enable --now ao`.


---

## Phase C — Cron auto-deploy *(build on the VM)*

9. Deploy script `/opt/ao/deploy.sh` — safe (only-if-new + build-to-temp + health-check + rollback):
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   cd /opt/ao/agent-orchestrator/backend
   git fetch origin release                                   # a 'release' branch/tag, not main
   [ "$(git rev-parse @)" = "$(git rev-parse origin/release)" ] && exit 0   # nothing new
   git pull --ff-only origin release
   go build -o /tmp/ao.new ./cmd/ao || { echo "build failed"; exit 1; }     # compile guard
   cp /usr/local/bin/ao /usr/local/bin/ao.prev               # keep last-good
   mv /tmp/ao.new /usr/local/bin/ao && systemctl restart ao
   sleep 3
   curl -fsS http://localhost:3001/healthz || {              # rollback if unhealthy
     echo "unhealthy → rollback"; mv /usr/local/bin/ao.prev /usr/local/bin/ao; systemctl restart ao; exit 1; }
   ```
10. Run on a **systemd timer** (or crontab) **once a day** (e.g. 4am): `0 4 * * * /opt/ao/deploy.sh >> /var/log/ao-deploy.log 2>&1`.
11. Deploy from a **`release` branch/tag**, not `main`, so only intentional pushes go live (avoids constant restarts).

> **Restart safety:** a redeploy restarts the daemon but does **not** kill work — Daytona sandboxes keep running in the cloud, and AO re-adopts sessions on boot. The live view blips for a few seconds while clients reconnect and the coordinator re-attaches (see Phase D step 17). The compile guard + health-check + rollback prevent a bad build from taking the daemon down.

---

## Phase D — Daytona integration *(core code)*

12. Thin **`ports.SandboxProvider`** (one implementation — always Daytona, no placement logic).
13. **`RemoteWorkspace`** on Daytona: `Create` = new sandbox + `git clone` the repo inside it; `Destroy` = terminate.
14. **`RemoteRuntime`** on Daytona: `Create` = start the agent process (Daytona process/PTY) → relay PTY to SSE; `Destroy` = kill.
15. Route all spawns to the Daytona adapters (`runtimeselect`); inject `GITHUB_TOKEN` + model key at sandbox create (env/secrets, never in the image). **v2:** inject the **wide env-var set** from the user profile — see Appendix A.
16. `sandboxes` table (session_id → Daytona sandbox id, status).
17. **Reconcile on boot: re-attach to still-running Daytona sandboxes** (read `sandboxes`, reconnect streams) so redeploys/restarts don't orphan running work.
18. Build + register the **sandbox image** in Daytona (contents per Phase A note + Appendix A).

---

## Phase E — Secure the daemon for remote access *(coordinator side)*

19. Add **`--server` mode** to the daemon (`ao daemon --server`):
    - **bind to the network** (not just loopback `127.0.0.1`),
    - **require a shared bearer token** (`AO_AUTH_TOKEN`) on every request,
    - **disable the client-gone auto-shutdown**.
    - Safety rule: network bind is allowed **only when a token is set** (can't accidentally expose a no-auth service).
20. **Caddy** in front → `https://<vm-domain>` (auto-TLS), proxy to the daemon; open 80/443, keep 3001 closed. *(needs a domain — see Appendix B for the free option.)*

> **`--server` mode is a coordinator change, not an app change.** It runs on the VM and makes the daemon reachable + protected + always-on. It is the **server-side half** of the connection; Phase F is the **client-side half**. You need both. See **Appendix C** for details.

---

## Phase F — Electron app changes *(client side)*

21. **Add remote-daemon config** — read `AO_REMOTE_DAEMON_URL` + `AO_AUTH_TOKEN` (env for v1; a "connect to server" settings screen later).
22. **Gate the daemon spawn** (`frontend/src/main.ts`, spawn logic ~623–922): if the remote URL is set, **don't launch a local daemon**.
23. **Skip the supervisor/lifecycle** in remote mode — don't start the watchdog, don't manage/update the daemon.
24. **Propagate URL + token to the renderer via IPC**, replacing the hardcoded loopback base.
25. **Renderer transport:** use that base for REST + attach `Authorization: Bearer <token>`; for **SSE**, handle auth via a fetch-based stream or a token in query/cookie (`EventSource` can't set headers).
26. **CSP:** allow the remote `https://<vm-domain>` host. *(No CSP change if just tunneling to `localhost:3001` first.)*

> **How Phase E and F pair up:**
> ```
> Electron app (laptop)                    Coordinator (Azure VM)
> — Phase F —                              — Phase E: --server —
> • don't spawn a local daemon             • bind to the network
> • connect to https://vm-url    ─────►    • check the token
> • attach the token                       • stay always-on
> ```
> `--server` opens and locks the door; the Electron changes walk through it with the key.

---

## Phase G — Smoke test

27. Spawn a cloud session → agent runs in Daytona → live view in the app.
28. Close the laptop → reopen → session current, agent kept working; PR on GitHub; teardown kills the sandbox.
29. Trigger a cron redeploy mid-session → daemon restarts, re-attaches to the running sandbox, live view resumes; a bad build rolls back.

---

## Deferred (not v1)

Conversation persistence (rich history replay), queue + autoscaling, Postgres, **DB backup (Litestream / off-box)**, real email/Google auth, Tailscale, laptop-local execution, mid-session local↔cloud switching.

---
---

# v2 additions

Everything above is v1. The sections below are the new detail.

## Appendix A — Harnesses & auth (v2 detail)

### Decision

- The single Daytona image **bakes in ALL 23 harness binaries** (plus git, tmux, curl, and project toolchains Node/npm, Python, Go). One fat image, so any harness the user picks is ready at boot.
- **Secrets are never baked in** — injected at sandbox create (Phase D step 15).
- **Auth model: install everything, then expose a WIDE range of env-var fields in the user profile; the user sets whatever key(s) they have.** The coordinator injects that full env set into the sandbox on create. A harness that finds its expected variable populated authenticates headlessly; the rest are simply unset and unused.

### All 23 harnesses need the binary in the image

Every harness is a **local CLI binary** — there is no "reach it by API key without a binary." So all 23 are installed into the image; the axis that matters is whether each then authenticates from an env-var API key (headless) or needs an interactive/OAuth login.

**Install approach (exact commands deferred):** most harnesses ship as global npm packages, a few as a pip package or a vendor `curl` installer, one or two as IDE/vendor downloads. Bake all of them into the one image and pin versions when it's built. Concrete per-harness install lines are intentionally left out here — not needed at the planning stage; resolve them when the image is actually built.

| Harness | Headless auth env var(s) | Class |
| :--- | :--- | :--- |
| claudecode | `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) | API-KEY |
| codex | `OPENAI_API_KEY` | API-KEY |
| aider | `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/… | API-KEY |
| amp | `AMP_API_KEY` | API-KEY |
| goose | provider key + `GOOSE_PROVIDER`/`GOOSE_MODEL` | API-KEY |
| droid | `FACTORY_API_KEY` | API-KEY |
| grok | `GROK_API_KEY`/`XAI_API_KEY` | API-KEY |
| kilocode | `KILOCODE_API_KEY`/`KILO_API_KEY` + provider | API-KEY |
| kimi | `MOONSHOT_API_KEY`/`KIMI_API_KEY`/`KIMI_CODE_API_KEY` | API-KEY |
| qwen | `OPENAI_API_KEY`+`OPENAI_BASE_URL` or `DASHSCOPE_API_KEY` | API-KEY |
| vibe | `MISTRAL_API_KEY`/`VIBE_CODE_API_KEY` | API-KEY |
| continueagent | `CONTINUE_API_KEY` (or provider keys) | API-KEY |
| crush | provider keys (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/…) | API-KEY |
| opencode | provider keys | API-KEY |
| pi | provider key | API-KEY |
| copilot | `GITHUB_TOKEN`/`GH_TOKEN`/`COPILOT_GITHUB_TOKEN` — **needs Copilot-entitled account** | API-KEY* |
| cursor | `CURSOR_API_KEY` | API-KEY |
| cline | provider `apiKey`/env (or OAuth) | API-KEY |
| auggie | `AUGMENT_SESSION_AUTH` token (else `auggie login`) | BINARY+LOGIN |
| kiro | **AWS Builder ID / social login only — no API-key path** | BINARY+LOGIN |
| devin | vendor cloud token | CLOUD-SAAS |
| autohand | cloud `auth.token` config — **identity unconfirmed** | CLOUD-SAAS |
| agy | AO does no key/login probe (assumes authed once binary present) — **identity unconfirmed** | unknown |

\* copilot's token env var is headless-capable, but the account must have a GitHub Copilot subscription. Confirm headless viability/identity of the flagged rows (kiro, devin, autohand, agy) in a scratch box before finalizing the image.

### The "wide range" of env vars to expose in the profile

The user profile presents fields for the union of variables the harnesses read; the user fills whichever they have. Injected verbatim into the sandbox at create.

- **Model/provider keys:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (+`OPENAI_BASE_URL`, `OPENAI_MODEL`), `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`/`GROK_API_KEY`, `MISTRAL_API_KEY`, `COHERE_API_KEY`, `DASHSCOPE_API_KEY`/`QWEN_API_KEY`, `MOONSHOT_API_KEY`/`KIMI_API_KEY`/`KIMI_CODE_API_KEY`.
- **Harness-specific:** `AMP_API_KEY`, `FACTORY_API_KEY`, `CONTINUE_API_KEY`, `KILOCODE_API_KEY`/`KILO_API_KEY`, `CURSOR_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `AUGMENT_SESSION_AUTH`, `VIBE_CODE_API_KEY`.
- **Provider selectors (multi-provider harnesses):** `GOOSE_PROVIDER`, `GOOSE_MODEL` (and any per-harness model/provider hints).
- **Git (separate secret, always needed):** `GITHUB_TOKEN` — clone/commit/push/PR. Distinct from the model key.

### Keep in mind

- **Not one key field** — it is a per-harness/per-provider env-var mapping; the wide-env approach handles this by exposing the whole union.
- **Multi-provider harnesses need provider + model**, not just a key (goose, qwen, aider, crush, opencode, kilocode, continue).
- **`GITHUB_TOKEN` is separate** from the model key and always required for the PR loop.
- **Run the adapter's existing `AuthStatus` probe inside the sandbox after injection** (e.g. `claude auth status`, `codex login status`, droid key check) to fail fast with "key missing/invalid" before burning a run.
- **Pin binary versions** in the image (these CLIs change flags/auth often; an unpinned `latest` will eventually break a redeploy).
- **v1 support set = the API-KEY harnesses.** Mark **kiro** (login-only), **devin**/**autohand** (cloud-SaaS), and **agy**/**autohand** (unidentified) as "not supported in cloud yet" until confirmed.

---

## Appendix B — Domain details (v2)

- **Caddy needs a real, publicly-resolvable DNS name** — Let's Encrypt will **not** issue a TLS cert for a bare IP. This is the whole reason a domain is required.
- **Free option (recommended):** attach an Azure **DNS name label** to the VM's public IP → `<label>.<region>.cloudapp.azure.com`. Point Caddy at it; auto-HTTPS works out of the box. **Zero cost, no extra account.** Fallbacks: **DuckDNS** (`*.duckdns.org`), **sslip.io/nip.io** (hostname encodes the IP). Avoid Freenom (`.tk/.ml`) — effectively dead.
- **Ports:** open **80 and 443** (80 is needed for Caddy's ACME HTTP-01 challenge; 443 for HTTPS). Keep **3001 closed** to the internet.
- **Caddy gives the cert for free (Let's Encrypt), not the domain** — the domain is a separate (free) thing you bring.

### Sandbox egress (Daytona networking)

If the Daytona sandbox has restricted egress, allowlist the hosts the agent needs at runtime:
- **Install registries** (only if installing at create-time rather than baked): `registry.npmjs.org`, `pypi.org`/`files.pythonhosted.org`, GitHub release hosts, `raw.githubusercontent.com`, `app.factory.ai`, `cursor.com`, `opencode.ai`.
- **Model API endpoints:** `api.anthropic.com`, `api.openai.com`, `api.x.ai`, `api.moonshot.ai`, `dashscope.aliyun.com`, `generativelanguage.googleapis.com`, `api.mistral.ai`, `openrouter.ai`, `api.groq.com`, `api.deepseek.com`, plus each harness vendor's endpoint (`ampcode.com`/Sourcegraph, `app.factory.ai`, `api.continue.dev`, `api.kilocode.ai`, etc.).
- **Git:** `github.com` (clone/push/PR).

---

## Appendix C — Server (`--server`) details (v2)

### What `--server` mode does

The daemon today binds `127.0.0.1` only, requires no auth, and self-stops when the app disconnects — all correct for a laptop, all fatal for an always-on coordinator. `ao daemon --server` flips the three:

1. **Bind to the network** (not just loopback) so the laptop can reach it.
2. **Require a shared bearer token** (`AO_AUTH_TOKEN`) on every request — the lock on the door.
3. **Disable the client-gone auto-shutdown** — the app closing is normal; agents keep running.
4. **Safety rule:** network bind is permitted **only when `AO_AUTH_TOKEN` is set** — you cannot accidentally expose a no-auth service.

### Implementation notes

- Make it a **first-class daemon change**, not a shadow path: reuse the existing bearer-password `authMiddleware` (the one the LAN/mobile listener already uses) rather than inventing a parallel token check. This is a real source change to the listener/auth model — **update the `AGENTS.md` loopback-only hard rule / add an ADR** to cover this third, token-gated network surface (source changes are acceptable — do not route around the rule).
- **SSE/mux auth:** `EventSource` can't set headers, so the renderer carries the token via a fetch-based stream or a query/cookie for `GET /api/v1/events` and the `/mux` WebSocket — same channel the REST bearer uses.

### Caddy pairing

- Caddy in front terminates HTTPS, auto-renews the Let's Encrypt cert, and proxies `https://<domain>` → `localhost:3001` (same box). Open 80/443, keep 3001 closed. See Appendix B for the free domain.

### Client token (v1)

- The laptop sets `AO_REMOTE_DAEMON_URL` + `AO_AUTH_TOKEN`; the token is just a shared string that must match the VM's `AO_AUTH_TOKEN`.
- For v1 it can be a **gitignored/env value in the Electron app** (never commit it — this repo is public and the desktop app ships from GitHub Releases; a committed/shipped literal stops being a gate).
- **Swappable to Google OIDC later** with no rearchitecture: both the static token and OIDC converge on the same two seams — one middleware that validates a bearer credential, one client that attaches it (REST + SSE + mux). Only the *source* of the credential changes. OIDC adds the login flow, `users`/`auth_sessions` tables, and token expiry/refresh (TLS is already in place via Caddy).