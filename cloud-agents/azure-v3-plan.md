# Azure + Daytona — Cloud Agents v3 Plan

**Status:** Plan (supersedes `hybrid-cloud-agents.md` and the v1 plan for v1 execution)
**Scope:** Single operator, pure-cloud execution. Prove the cloud-agent loop with the least moving parts.

> **v3 adds** a **Runtime model** section (where the Lifecycle Manager and AO hooks live, how
> Daytona talks to the coordinator, what comes back and how, and what the UI streams do). The
> build phases are unchanged from v1 except two small touch-ups (the `ao` binary in the image;
> hooks + activity wiring in Phase D).
>
> This plan reflects decisions made in planning and **supersedes the rev3 design doc** where they
> conflict. The design doc specifies Postgres + an `ssh`-to-VM provider + mandatory auth; v1 below
> uses **SQLite + Daytona + a shared token**, all deferred upgrades.

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

## Runtime model — where things live and how data flows

*New in v3. The phases below say **what to build**; this says how the running system **talks**.*

**Lifecycle Manager — 100% on the coordinator.** `internal/lifecycle` is the reducer that turns
observations (liveness, activity, spawn/exit) into durable session facts and drives nudges +
notifications. No client or sandbox half; it writes the coordinator's SQLite. *Execution moves to
the sandbox; state stays on the coordinator.* Nothing to move.

**AO hooks — in the sandbox.** A hook is (1) a small config file the adapter writes into the
agent's workspace (e.g. `.claude/settings.json`) and (2) the `ao` binary — each hook runs
`ao hooks <agent> <event>` as a local subprocess when the agent fires an event. Both live in the
sandbox: config written via Daytona's fs at create; the `ao` binary baked into the image. Only this
thin hook slice of `ao` runs in the sandbox — the rest of AO stays on the coordinator.

**Coordinator ↔ Daytona — the coordinator dials out; nothing dials back.** The coordinator holds a
Daytona API key and drives the sandbox through the SDK: create sandbox + git clone
(`RemoteWorkspace`), start/kill the agent over Daytona's PTY (`RemoteRuntime`), inject secrets at
create. No reverse tunnel, no `aorunner`.

**What comes back to the coordinator, and how:**
- **PTY (terminal bytes)** — on the coordinator's **own outbound Daytona stream** (the read side of the call it made).
- **Liveness** — the coordinator **pulls** from Daytona (process/sandbox alive?) → reaper → Lifecycle Manager.
- **Activity signals** — the in-sandbox `ao hooks` **POSTs to the coordinator's public URL + token** *(the one new wire)*.
- **PR / CI** — **not** from the sandbox: the agent `git push`es to GitHub; the coordinator's SCM observer polls GitHub.

**Coordinator → UI — unchanged; three existing channels:**
- **`/mux` (WebSocket, two-way)** — the live **terminal**: streams PTY bytes out, carries keystrokes/resize back. "mux" = one socket multiplexes every session's pane.
- **`/api/v1/events` (SSE, server→UI)** — **state-change feed** (session activity, PR status) off the DB's CDC; drives live re-render.
- **`/api/v1/notifications/stream` (SSE, server→UI)** — **user-facing alerts** (needs-input, completed).
- *Auth note:* a browser can't set headers on any of the three, so the shared token reaches them via **cookie** (Phase F).

```
UI ◄─ /mux WS + 2 SSE ── Coordinator (Azure VM) ── Daytona API ─► sandbox
                         Lifecycle Mgr + SQLite      (PTY stream, liveness poll)
        sandbox: `ao` binary + hook config ── activity POST ─► Coordinator
        sandbox: agent ── git push ─► GitHub ── poll ─► Coordinator SCM observer
```

---

## Phase A — Prep

1. `az login`; confirm Azure credits.
2. **Daytona** account + **API key**.
3. **Decide the sandbox image contents** (see note below).

> ### What "sandbox image contents" means
> Each cloud agent runs in a disposable Daytona **sandbox**, created from a **template = the image**. "Pick the contents" = decide what's pre-installed so the agent is ready to work the moment the sandbox boots:
> - **Base OS** (e.g. Ubuntu),
> - **git** (clone/commit/push),
> - **the agent CLI** (the AI program that does the work, e.g. Claude Code),
> - **the `ao` binary** (runs the activity hooks — the hook command is `ao hooks <agent> <event>`),
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
   curl -fsS http://localhost:3001/readyz || {               # rollback if not ready
     echo "unhealthy → rollback"; mv /usr/local/bin/ao.prev /usr/local/bin/ao; systemctl restart ao; exit 1; }
   ```
10. Run on a **systemd timer** (or crontab) **once a day** (e.g. 4am): `0 4 * * * /opt/ao/deploy.sh >> /var/log/ao-deploy.log 2>&1`.
11. Deploy from a **`release` branch/tag**, not `main`, so only intentional pushes go live (avoids constant restarts).

> **Restart safety:** a redeploy restarts the daemon but does **not** kill work — Daytona sandboxes keep running in the cloud, and AO re-adopts sessions on boot. The live view blips for a few seconds while clients reconnect and the coordinator re-attaches (see Phase D step 17). The compile guard + health-check + rollback prevent a bad build from taking the daemon down.

---

## Phase D — Daytona integration *(core code)*

12. Thin **`ports.SandboxProvider`** (one implementation — always Daytona, no placement logic).
13. **`RemoteWorkspace`** on Daytona: `Create` = new sandbox + `git clone` the repo inside it + **install the AO hook config into the workspace via Daytona's fs** (the adapter's hook installer writes through Daytona, not local disk); `Destroy` = terminate.
14. **`RemoteRuntime`** on Daytona: `Create` = start the agent process (Daytona process/PTY) → relay PTY to SSE; `Destroy` = kill.
15. Route all spawns to the Daytona adapters (`runtimeselect`); inject `GITHUB_TOKEN` + model key at sandbox create (env/secrets, never in the image) **+ the coordinator URL + `AO_AUTH_TOKEN`** so the in-sandbox `ao hooks` POST activity to the coordinator (not a loopback run-file).
16. `sandboxes` table (session_id → Daytona sandbox id, status).
17. **Reconcile on boot: re-attach to still-running Daytona sandboxes** (read `sandboxes`, reconnect streams) so redeploys/restarts don't orphan running work. Distinguish *stopped-but-not-destroyed* (Daytona auto-stop → restart + re-attach) from *terminated* (mark dead).
18. Build + register the **sandbox image** in Daytona (contents per Phase A note).

> **Activity path (the one new wire):** the agent fires a native hook → runs `ao hooks <agent> <event>` in the sandbox → that `ao` POSTs the derived state to the coordinator's `POST /api/v1/sessions/{id}/activity` over the public URL + token → the coordinator's Lifecycle Manager writes it → CDC → SSE to the UI. PTY and liveness need no such POST (they ride the coordinator's outbound Daytona connection).

---

## Phase E — Secure the daemon for remote access *(coordinator side)*

19. Add **`--server` mode** to the daemon (`ao daemon --server`):
    - **bind to the network** (not just loopback `127.0.0.1`),
    - **require a shared bearer token** (`AO_AUTH_TOKEN`) on every request,
    - **disable the client-gone auto-shutdown**.
    - Safety rule: network bind is allowed **only when a token is set** (can't accidentally expose a no-auth service).
    - **Reuse the Connect Mobile bridge** (`internal/httpd/lan_listener.go` + `auth.go` + `mobilebridge`), which already binds the network behind bearer-token auth + lockout — generalize it for an always-on cloud bind rather than writing new middleware.
20. **Caddy** in front → `https://<vm-domain>` (auto-TLS), proxy to the daemon; open 80/443, keep 3001 closed. *(needs a cheap domain)*

> **`--server` mode is a coordinator change, not an app change.** It runs on the VM and makes the daemon reachable + protected + always-on. It is the **server-side half** of the connection; Phase F is the **client-side half**. You need both.

---

## Phase F — Electron app changes *(client side)*

21. **Add remote-daemon config** — read `AO_REMOTE_DAEMON_URL` + `AO_AUTH_TOKEN` (env for v1; a "connect to server" settings screen later).
22. **Gate the daemon spawn** (`frontend/src/main.ts`, spawn logic ~623–922): if the remote URL is set, **don't launch a local daemon**, and **relax the daemon identity check** (`daemonIdentityError` / `resolveDaemonFromPort`) so a remote binary isn't rejected as foreign.
23. **Skip the supervisor/lifecycle** in remote mode — don't establish the supervisor link, don't manage/update the daemon.
24. **Point the renderer at the remote base** via the existing swap point (`setApiBaseUrl` / `VITE_AO_API_BASE_URL`) — the base URL is already runtime-swappable; the `/mux` + SSE URLs derive from it.
25. **Header-less stream auth (all three, not just SSE):** the browser can't set `Authorization` on `/mux` (WebSocket), `/api/v1/events`, or `/api/v1/notifications/stream`. Broaden the existing `ao_conn` **cookie** (today scoped to `/preview/files/`) to cover these routes in server mode, and have the Electron main process set that cookie for the remote origin (`session.cookies.set`) — then REST + terminal + both event streams all authenticate automatically.
26. **CSP:** allow the remote `https://<vm-domain>` host. *(No CSP change if just tunneling to `localhost:3001` first.)*

> **How Phase E and F pair up:**
> ```
> Electron app (laptop)                    Coordinator (Azure VM)
> — Phase F —                              — Phase E: --server —
> • don't spawn a local daemon             • bind to the network
> • connect to https://vm-url    ─────►    • check the token
> • attach the token (cookie)              • stay always-on
> ```
> `--server` opens and locks the door; the Electron changes walk through it with the key.

---

## Phase G — Smoke test

27. Spawn a cloud session → agent runs in Daytona → live view (`/mux`) + status (SSE) in the app.
28. Close the laptop → reopen → session current, agent kept working; PR on GitHub; teardown kills the sandbox.
29. Trigger a cron redeploy mid-session → daemon restarts, re-attaches to the running sandbox, live view resumes; a bad build rolls back.
30. **Orphan/cost check:** kill the coordinator mid-session, restart → the boot sweep terminates any Daytona sandbox whose `sandboxes` row has no live session (remote sandboxes cost money).

---

## Deferred (not v1)

Conversation persistence (rich history replay), queue + autoscaling, Postgres, **DB backup (Litestream / off-box)**, real email/Google auth, Tailscale, laptop-local execution, mid-session local↔cloud switching.