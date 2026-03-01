# Industry-Standard Plugin Catalog — Complete Research

> **Date**: 2026-02-25
> **Purpose**: Comprehensive catalog of every industry-standard plugin that can be added to the orchestrator, organized by plugin slot, with API details, SDKs, and priority rankings.

---

## Summary: Total Plugin Opportunities Identified

| Slot | Currently Have | New Plugins Identified | Total Possible |
|------|---------------|----------------------|----------------|
| **Runtime** | 2 (tmux, process) | 12 (Docker, E2B, Daytona, Modal, Fly.io, Morph, Cloudflare, Hetzner, OpenSandbox, K8s-sandbox, Podman, LXC) | 14 |
| **Agent** | 4 (claude-code, codex, aider, opencode) | 12 (gemini, cline, copilot, goose, continue, kiro, amazon-q, cursor, auggie, trae, openhands, amp) | 16 |
| **Workspace** | 2 (worktree, clone) | 5 (devcontainer, container-use, overlay, tempdir, docker-compose) | 7 |
| **Tracker** | 2 (github, linear) | 10 (jira, gitlab, shortcut, azure-devops, clickup, plane, asana, monday, trello, youtrack) | 12 |
| **SCM** | 1 (github) | 5 (gitlab, bitbucket, azure-devops, gitea, gerrit) | 6 |
| **Notifier** | 4 (desktop, slack, composio, webhook) | 13 (discord, teams, telegram, email, google-chat, mattermost, ntfy, pagerduty, pushover, sms, lark, dingtalk, webex) | 17 |
| **Terminal** | 2 (iterm2, web) | 6 (kitty, wezterm, zellij, cmux, ghostty, windows-terminal) | 8 |
| **Cross-cutting** | 0 | 6 (opentelemetry, prometheus, sentry, secret-providers, ci-standalone, memory) | 6 |
| **TOTAL** | **17** | **69** | **86** |

---

## 1. AGENT PLUGINS (agent-*)

### Currently Have
- `agent-claude-code`, `agent-codex`, `agent-aider`, `agent-opencode`

### New Agents — Prioritized

| Priority | Plugin | Stars | Headless Flag | Auto-Approve Flag | JSON Output | Install |
|----------|--------|-------|---------------|-------------------|-------------|---------|
| **P0** | `agent-gemini` | 94k | `-p` | `--yolo` | `--output-format json` | `npm i -g @google/gemini-cli` |
| **P0** | `agent-cline` | 57k | `-y` | `--yolo` | `--json` | `npm i -g @anthropic-ai/cline-cli` |
| **P0** | `agent-copilot` | — | `-p` | `--allow-all-tools` | Partial | `gh extension install github/copilot-cli` |
| **P0** | `agent-goose` | 27k | `run -t "task"` | N/A (non-interactive) | Session list JSON | `brew install block/tap/goose` |
| **P1** | `agent-continue` | 31.5k | `-p` | `--auto` | `--format json` | `npm i -g @continuedev/cli` |
| **P1** | `agent-kiro` | 3k | `--no-interactive` | `--trust-all-tools` | No | `npm i -g kiro-cli` |
| **P1** | `agent-amazon-q` | 4.5k | `--no-interactive` | `--trust-all-tools` | No | `brew install amazon-q` |
| **P2** | `agent-cursor` | 32k | `-p` | `--trust` | `--output-format json` | Ships with Cursor IDE |
| **P2** | `agent-auggie` | 143 | `--print` | `--quiet` | No | `npm i -g @augmentcode/auggie` |
| **P2** | `agent-trae` | 10k | `trae-cli run "task"` | N/A | Trajectory file | `pip install trae-agent` |
| **P2** | `agent-openhands` | 65k | `--headless -t` | N/A | `--json` | `pip install openhands` |
| **P2** | `agent-amp` | — | `-x` | `--dangerously-allow-all` | No | `npm i -g @sourcegraph/amp` |

**Key pattern**: All agents follow the same integration pattern — `-p`/headless flag maps to `config.prompt`, `--yolo`/auto-approve maps to `config.permissions`, process exit = task complete.

---

## 2. TRACKER PLUGINS (tracker-*)

### Currently Have
- `tracker-github`, `tracker-linear`

### New Trackers — Prioritized

| Priority | Plugin | Market Share | API Type | Auth | npm SDK | Feasibility |
|----------|--------|-------------|----------|------|---------|-------------|
| **P0** | `tracker-jira` | 89% (dominant) | REST v3 | Basic Auth (email+token) | `jira.js` (excellent) | Easy-Medium |
| **P1** | `tracker-gitlab` | Very high | REST v4 | PAT header | `@gitbeaker/rest` | Easy |
| **P1** | `tracker-shortcut` | Popular startups | REST v3 | API Token header | `@shortcut/client` (official) | Easy |
| **P1** | `tracker-azure-devops` | High enterprise | REST v7.1 | PAT (Basic Auth) | `azure-devops-node-api` (official) | Medium |
| **P2** | `tracker-clickup` | 20M+ users | REST v2 | API Token header | `@yoryoboy/clickup-sdk` | Easy-Medium |
| **P2** | `tracker-plane` | Growing OSS | REST | API Key header | `@makeplane/plane-node-sdk` (official) | Easy |
| **P2** | `tracker-asana` | $188M/Q4 revenue | REST v1 | PAT (Bearer) | `asana` (official) | Medium |
| **P3** | `tracker-monday` | Public company | GraphQL | API Token | `@mondaydotcomorg/api` (official) | Medium |
| **P3** | `tracker-trello` | Very popular | REST v1 | API Key + Token | `trello.js` | Easy-Medium |
| **P3** | `tracker-youtrack` | JetBrains users | REST | Token (Bearer) | `youtrack-rest-client` | Easy-Medium |

**Jira key detail**: Status transitions require 2 API calls — first `GET /transitions` to find available transition IDs, then `POST /transitions` with the ID. Unlike GitHub/Linear which allow direct state setting.

---

## 3. SCM PLUGINS (scm-*)

### Currently Have
- `scm-github`

### New SCMs — Prioritized

| Priority | Plugin | Market Share | CLI Tool | npm SDK | Key Difference from GitHub |
|----------|--------|-------------|----------|---------|---------------------------|
| **P0** | `scm-gitlab` | ~29% | `glab` (official) | `@gitbeaker/rest` | "Merge Request", Pipelines, `iid` not `number` |
| **P1** | `scm-bitbucket` | ~18-21% | None official | `@coderabbitai/bitbucket` (TS) | Cloud vs Data Center APIs differ, simpler approvals |
| **P1** | `scm-azure-devops` | ~13-14% | `az repos pr` | `azure-devops-node-api` (official) | Numeric votes (-10 to 10), Policies not branch rules |
| **P2** | `scm-gitea` | Niche (growing) | `tea` | `gitea-js` (auto-generated) | Covers Gitea + Forgejo + Codeberg |
| **P3** | `scm-gerrit` | Android/Chromium | None | None maintained | "Changes" with "Patch Sets", voting (-2 to +2) |

**GitLab** is the highest priority — `glab` CLI mirrors `gh` almost exactly, making the port straightforward.

---

## 4. RUNTIME PLUGINS (runtime-*)

### Currently Have
- `runtime-tmux`, `runtime-process`

### New Runtimes — Prioritized

| Priority | Plugin | Type | Startup Time | Cost/hr | TS SDK | Best For |
|----------|--------|------|-------------|---------|--------|---------|
| **P0** | `runtime-docker` | Container | ~500ms | Free (self-hosted) | `dockerode` | Universal, everyone has Docker |
| **P0** | `runtime-e2b` | Firecracker VM | ~150ms | ~$0.10 | `e2b` (official) | Cloud sandboxes, purpose-built for agents |
| **P1** | `runtime-daytona` | Container/VM | ~200ms | ~$0.10 | `@daytonaio/sdk` (official) | AI agent infrastructure |
| **P1** | `runtime-modal` | gVisor container | 2-4s | ~$0.28 | `@modal-labs/sdk` (beta) | GPU support, sandboxes |
| **P2** | `runtime-fly` | Firecracker VM | <1s | ~$0.01-0.05 | `fly-machines-sdk` | Global deployment, cheap |
| **P2** | `runtime-morph` | VM + snapshots | Instant (snapshot) | Contact sales | `morph-typescript-sdk` | Snapshot/branch model |
| **P2** | `runtime-cloudflare` | Edge container | Fast | ~$0.07/hr active | `@cloudflare/sandbox-sdk` | Edge, pay-for-active |
| **P2** | `runtime-opensandbox` | Docker/K8s | 30s | Depends | TypeScript SDK | Docker+K8s dual runtime |
| **P3** | `runtime-k8s-sandbox` | K8s CRD | <1s (warm pool) | Cluster cost | Python SDK only | K8s-native, gVisor/Kata |
| **P3** | `runtime-hetzner` | Full VM | 10-30s | ~$0.006 | Generated from OpenAPI | Cheapest VMs ($3.49/mo) |
| **P3** | `runtime-podman` | Daemonless container | ~500ms | Free | Docker-compatible | Rootless, reuse Docker code |
| **P4** | `runtime-lxc` | System container | 1-3s | Free | REST API | Self-hosted, VM-like |

---

## 5. NOTIFIER PLUGINS (notifier-*)

### Currently Have
- `notifier-desktop`, `notifier-slack`, `notifier-composio`, `notifier-webhook`

### New Notifiers — Prioritized

| Priority | Plugin | Users | API | Auth | Code Blocks | Buttons | npm SDK |
|----------|--------|-------|-----|------|-------------|---------|---------|
| **P0** | `notifier-discord` | 231M MAU | Webhook POST | URL token | Yes (syntax hl) | Yes (embeds) | `discord.js` |
| **P0** | `notifier-teams` | 360M MAU | Webhook + Adaptive Cards | URL token | Monospace | Yes | Plain `fetch` |
| **P0** | `notifier-telegram` | 1B MAU | Bot API POST | Bot token | Yes (syntax hl) | Yes (inline keyboard) | `grammy` or `fetch` |
| **P0** | `notifier-email` | Universal | Resend/SMTP | API key | Yes (HTML pre) | Links only | `resend` / `nodemailer` |
| **P1** | `notifier-google-chat` | 100M+ | Webhook + Cards v2 | URL token | Monospace | Yes (card buttons) | Plain `fetch` |
| **P1** | `notifier-mattermost` | Self-hosted | Slack-compatible webhook | URL token | Yes (markdown) | Yes (interactive) | Plain `fetch` |
| **P1** | `notifier-ntfy` | Growing OSS | PUT/POST to topic | None (public) | Markdown | Yes (3 actions) | Plain `fetch` |
| **P1** | `notifier-pagerduty` | Industry standard | Events API v2 | Routing key | No | No (in-app) | `@pagerduty/pdjs` |
| **P2** | `notifier-pushover` | Sysadmins | POST | App+User token | Limited | No | `pushover-notifications` |
| **P2** | `notifier-sms` | Universal | Twilio REST | SID + Auth Token | No | No | `twilio` (official) |
| **P2** | `notifier-lark` | China/Asia tech | Webhook + Card API | URL token | Yes (markdown) | Yes (card buttons) | `@larksuiteoapi/node-sdk` |
| **P2** | `notifier-dingtalk` | 700M registered | Webhook + ActionCard | URL token + HMAC | Yes (markdown) | Yes (ActionCard) | `dingtalk-robot` |
| **P3** | `notifier-webex` | 18M+ Calling | Bot API + Adaptive Cards | Bot token | Yes (markdown) | Yes (Adaptive Cards) | `webex` (official) |

**Discord, Teams, Telegram, Email** cover ~90% of dev teams combined with existing Slack + Desktop plugins.

---

## 6. TERMINAL PLUGINS (terminal-*)

### Currently Have
- `terminal-iterm2`, `terminal-web`

### New Terminals — Prioritized

| Priority | Plugin | Platforms | Create Tab | Focus Tab | Send Text | Read Content | Protocol |
|----------|--------|-----------|------------|-----------|-----------|--------------|----------|
| **P0** | `terminal-kitty` | macOS, Linux | `kitten @ launch --type=tab` | `kitten @ focus-tab` | `kitten @ send-text` | `kitten @ get-text` | JSON/socket |
| **P0** | `terminal-wezterm` | macOS, Linux, Win | `wezterm cli spawn` | `wezterm cli activate-tab` | `wezterm cli send-text` | `wezterm cli get-text` | CLI |
| **P1** | `terminal-zellij` | macOS, Linux | `zellij action new-tab` | `zellij action go-to-tab` | `zellij action write-chars` | `zellij action dump-screen` | CLI |
| **P1** | `terminal-cmux` | macOS only | Socket API | Socket API | Socket API | Socket API | Unix socket |
| **P2** | `terminal-ghostty` | macOS, Linux | AppleScript (macOS) | AppleScript | AppleScript | AppleScript | AppleScript |
| **P2** | `terminal-windows-terminal` | Windows | `wt.exe nt` | `wt.exe ft` | Not supported | Not supported | CLI args |

**Kitty** and **WezTerm** are the highest priority — richest APIs, cross-platform, structured output.

---

## 7. WORKSPACE PLUGINS (workspace-*)

### Currently Have
- `workspace-worktree`, `workspace-clone`

### New Workspaces — Prioritized

| Priority | Plugin | Isolation | Setup Speed | Git History | Cross-Platform |
|----------|--------|-----------|-------------|-------------|----------------|
| **P0** | `workspace-devcontainer` | Container | 30s-5min | Yes | macOS/Linux/Win |
| **P1** | `workspace-container-use` | Container+Worktree | 10-30s | Yes (branch) | Linux/macOS |
| **P1** | `workspace-overlay` | Filesystem CoW | ~100ms | Read-only | Linux only |
| **P2** | `workspace-tempdir` | Directory | 1-5s | Yes | All |
| **P3** | `workspace-docker-compose` | Container+Network | 30s-2min | Yes | All |

**DevContainers** is the industry standard — many projects already have `.devcontainer/devcontainer.json`.

---

## 8. CROSS-CUTTING ENHANCEMENTS

### Observability

| Priority | Tool | Integration Point | npm SDK |
|----------|------|-------------------|---------|
| **P0** | OpenTelemetry | Core init + spans | `@opentelemetry/sdk-node` |
| **P0** | Prometheus | `/metrics` endpoint | `prom-client` |
| **P0** | Sentry | Error tracking | `@sentry/node` |
| **P1** | Datadog | Events/metrics export | `dd-trace` / `datadog-metrics` |
| **P2** | Axiom | Log ingestion | `@axiomhq/logging` |

### Secret Management

| Priority | Tool | Integration | npm SDK |
|----------|------|-------------|---------|
| **P1** | Doppler | `doppler run -- ao start` (zero-code) | Doppler SDK |
| **P1** | 1Password | `op run -- ao start` (zero-code) | `@1password/sdk` |
| **P1** | Vault | `SecretProvider` interface | `node-vault` |
| **P2** | AWS Secrets Manager | `SecretProvider` interface | `@aws-sdk/client-secrets-manager` |
| **P2** | Infisical | `SecretProvider` interface | `@infisical/sdk` |

### CI/CD (Standalone — for non-GitHub/GitLab CI)

| Priority | Tool | API | npm SDK |
|----------|------|-----|---------|
| **P1** | CircleCI | REST v2 | Plain `fetch` |
| **P1** | Jenkins | REST | `jenkins` |
| **P2** | Buildkite | REST + GraphQL | Plain `fetch` |
| **P2** | Vercel | REST (preview URLs) | `@vercel/client` |
| **P3** | Azure Pipelines | REST v7.1 | `azure-devops-node-api` |

---

## Implementation Roadmap

### Phase 1 — Maximum Impact (covers ~90% of teams)

| # | Plugin | Slot | Effort |
|---|--------|------|--------|
| 1 | `agent-gemini` | Agent | Low |
| 2 | `agent-cline` | Agent | Low |
| 3 | `agent-copilot` | Agent | Low |
| 4 | `agent-goose` | Agent | Low |
| 5 | `tracker-jira` | Tracker | Medium |
| 6 | `scm-gitlab` | SCM | Medium |
| 7 | `runtime-docker` | Runtime | Medium |
| 8 | `notifier-discord` | Notifier | Low |
| 9 | `notifier-teams` | Notifier | Low |
| 10 | `notifier-telegram` | Notifier | Low |
| 11 | `notifier-email` | Notifier | Low |
| 12 | `terminal-kitty` | Terminal | Low |

### Phase 2 — Enterprise & Cloud

| # | Plugin | Slot | Effort |
|---|--------|------|--------|
| 13 | `runtime-e2b` | Runtime | Low |
| 14 | `runtime-daytona` | Runtime | Low |
| 15 | `scm-bitbucket` | SCM | Medium |
| 16 | `scm-azure-devops` | SCM | Medium |
| 17 | `tracker-shortcut` | Tracker | Low |
| 18 | `tracker-azure-devops` | Tracker | Medium |
| 19 | `tracker-clickup` | Tracker | Low |
| 20 | `agent-continue` | Agent | Low |
| 21 | `agent-kiro` | Agent | Low |
| 22 | `terminal-wezterm` | Terminal | Low |
| 23 | `workspace-devcontainer` | Workspace | Medium |

### Phase 3 — Comprehensive Coverage

| # | Plugin | Slot | Effort |
|---|--------|------|--------|
| 24-27 | `notifier-google-chat/mattermost/ntfy/pagerduty` | Notifier | Low each |
| 28-30 | `tracker-plane/asana/monday` | Tracker | Low-Medium |
| 31-33 | `runtime-modal/fly/morph` | Runtime | Medium |
| 34 | `scm-gitea` | SCM | Low |
| 35 | `terminal-zellij` | Terminal | Low |
| 36 | `workspace-overlay` | Workspace | Medium |
| 37-40 | `agent-cursor/auggie/trae/openhands` | Agent | Low each |

### Phase 4 — Long Tail

Remaining agents, regional notifiers (Lark, DingTalk, Webex), niche trackers (Trello, YouTrack, Redmine), specialized runtimes (Hetzner, Podman, LXC), Gerrit SCM, and cross-cutting enhancements (OpenTelemetry, Prometheus, Sentry, SecretProvider).

---

## Sources

All research sourced from official API documentation, GitHub repositories, npm registries, DeepWiki, Stack Overflow Developer Survey 2025, and market analysis reports. Detailed per-platform sources available in agent research transcripts.
