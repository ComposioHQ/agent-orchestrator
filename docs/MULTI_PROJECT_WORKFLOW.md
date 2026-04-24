# Multi-Session, Multi-Project Workflows

A practical guide to running Agent Orchestrator (AO) across **many projects at once**, each with its own fleet of agents, from a single dashboard.

> **Audience:** You already have AO running on one repo. You want to scale out — 2, 5, or 20 repos — without losing track of what each agent is doing.
>
> **Prerequisites:** [Setup Guide](../SETUP.md) · [CLI Reference](CLI.md) · [Examples](../examples/)

---

## TL;DR

- **Prefer one orchestrator over many.** A single `agent-orchestrator.yaml` with several entries under `projects:` is the supported multi-project mode. One dashboard, one lifecycle loop, one notification pipeline.
- **Use separate orchestrators only for isolation reasons** — different machines, different clients, or a throwaway sandbox you don't want polluting your main dashboard.
- **Let `ao start` add projects for you** — `ao start ~/another-repo` merges a new project into the current config instead of creating a parallel setup.
- **Scale with `ao batch-spawn`** — one command, one pre-flight check, N sessions. Duplicate detection is built in.
- **Watch the dashboard, not the terminals.** The dashboard's project sidebar is where multi-project coordination happens. The CLI is for edge cases.

---

## 1. Multi-project setup

### 1a. The data model

AO stores everything in `~/.agent-orchestrator/{hash}-{projectId}/`, where:

- `{hash}` is the first 12 chars of `sha256(dirname(configPath))` — so two configs in two different directories get two different hashes.
- `{projectId}` is the key you use under `projects:` in the YAML.

This matters because **every project under the same config shares the same hash**. Sessions, worktrees, archives, and tmux session names all live under that shared hash, which is how the dashboard and lifecycle manager can treat them as a coordinated fleet.

If you split a config into two files (two different directories), you get two hashes, two dashboards, two sets of `~/.agent-orchestrator/{hash}-*/` directories, and zero cross-visibility. That's usually not what you want.

### 1b. A minimal multi-project config

```yaml
# agent-orchestrator.yaml
port: 3000

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  frontend:
    repo: org/frontend
    path: ~/code/frontend
    defaultBranch: main
    sessionPrefix: fe

  backend:
    repo: org/backend
    path: ~/code/backend
    defaultBranch: main
    sessionPrefix: api

  mobile:
    repo: org/mobile
    path: ~/code/mobile
    defaultBranch: develop
    sessionPrefix: mob
```

That's it. Start once:

```bash
ao start
```

The dashboard opens at `http://localhost:3000` and shows all three projects in the sidebar. The orchestrator agent and lifecycle worker both cover every project in the file.

### 1c. Adding a project to an existing config

You don't have to hand-edit the YAML. From anywhere:

```bash
ao start ~/code/new-repo
```

If there's already a running `ao start` instance, AO merges `new-repo` into the same `agent-orchestrator.yaml` and restarts the lifecycle loop so the new project is polled. No duplicate dashboard, no config fork.

### 1d. Per-project overrides

Most settings are project-scoped. Use the project block to diverge where it matters:

```yaml
projects:
  frontend:
    repo: org/frontend
    path: ~/code/frontend
    tracker:
      plugin: github
    agentRules: |
      Use TypeScript strict mode.
      Always run `pnpm test` before pushing.

  backend:
    repo: org/backend
    path: ~/code/backend
    tracker:
      plugin: linear
      teamId: backend-team
    agentRules: |
      All endpoints need auth middleware and OpenAPI docs.
    agentConfig:
      model: opus # backend gets the bigger model
      permissions: skip
    reactions:
      approved-and-green:
        auto: true # auto-merge on backend only
```

Project-level `reactions:` overrides the top-level defaults for that project only. Project-level `agentConfig:` and `agentRules:` apply to every session spawned into that project.

See [`agent-orchestrator.yaml.example`](../agent-orchestrator.yaml.example) for the full reference, or run `ao config-help`.

---

## 2. Session management across projects

### 2a. Spawn, targeted to a project

The `ao spawn` command auto-detects which project you mean:

1. If only one project exists → that one.
2. Else, if `$AO_PROJECT_ID` is set (always true inside an agent session) → that one.
3. Else, if `cwd` is inside a configured `path:` → that project.
4. Else → error, listing project IDs.

So in practice:

```bash
cd ~/code/frontend && ao spawn 123         # → frontend
cd ~/code/backend  && ao spawn LIN-456     # → backend
```

Don't worry about memorizing project keys — spawn from the repo directory.

### 2b. Batch spawning

For any campaign (triage, sprint kickoff, bulk docs pass, migration), `ao batch-spawn` is the right tool:

```bash
cd ~/code/backend && ao batch-spawn 201 202 203 204 205
```

What it does:

- Runs pre-flight once (tmux, `gh` auth, runtime checks) — fails fast if something's broken.
- Loads existing sessions once, so duplicates are detected against non-terminal sessions only (a merged issue can be respawned if reopened).
- Skips issues you already have a live session for, instead of creating zombies.
- Reports created / skipped / failed at the end.

Batch-spawn is **per-project**, intentionally. If you want to start 5 frontend and 5 backend agents, run it twice from the two directories. This keeps tracker auth, rules, and agent config correct per batch.

### 2c. Monitoring

| Tool                                 | When to use                                                             |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Dashboard (`ao dashboard` → browser) | Default. Multi-project sidebar, live state, PR status, terminal attach. |
| `ao status`                          | Quick one-shot overview in the terminal.                                |
| `ao status --watch`                  | Live terminal view — useful on a secondary monitor.                     |
| `ao session ls`                      | Scripting / debugging. `--json` for machine-readable output.            |

The dashboard polls via SSE every 5 seconds and is the only view that shows every project side-by-side. The lifecycle manager polls plugins every 30s — you do not need a faster loop; the plugins push events.

### 2d. Cross-project tasks

Some tasks span repos (e.g. coordinated release, API change + client change). Two patterns work:

1. **Two sessions, two issues, linked in the tracker.** Preferred. Each agent focuses on its repo; you coordinate the merge order.
2. **One "meta" session with both repos in its workspace.** Only for orchestrator-style work; most agents do not handle multiple repos well. Skip unless you have a specific reason.

Agents do _not_ see each other's sessions by default. If you need cross-agent awareness, use the orchestrator agent — it already watches every project under the current config.

---

## 3. Orchestrator per project vs shared orchestrator

A "shared" orchestrator means one `ao start` process, one config file, N projects. A "per-project" orchestrator means N separate config files in N directories, each with its own `ao start`.

### 3a. Default: one shared orchestrator

Use a shared orchestrator when:

- All projects belong to the same org / team / human.
- You want one dashboard to supervise everything.
- You're fine with shared reaction defaults (with per-project overrides where needed).
- Projects are on the same machine.

This is the path `ao start` optimizes for. Adding `ao start ~/another-repo` merges into the current config rather than forking.

### 3b. When to split into separate orchestrators

Create a second config only if at least one of these is true:

- **Different machines.** A project on a remote server / container host cannot share state with your laptop.
- **Hard isolation required.** Different clients, different secrets, different audit boundaries. Separate dashboards keep data from mixing.
- **Different user accounts.** Two humans on the same box want their own sessions.
- **Throwaway sandbox.** Experimenting with plugins or settings you don't want to disturb your main fleet.

Each split orchestrator needs its own port — set `port:` in the YAML (and `terminalPort:` / `directTerminalPort:` if you hit `EADDRINUSE`):

```yaml
# ~/work-ao/agent-orchestrator.yaml
port: 3000
terminalPort: 14800
directTerminalPort: 14801

# ~/personal-ao/agent-orchestrator.yaml
port: 3100
terminalPort: 14900
directTerminalPort: 14901
```

Two orchestrators = two hashes = two `~/.agent-orchestrator/{hash}-*/` trees. They cannot see each other's sessions.

### 3c. Rule of thumb

If you're asking "should I split?", the answer is almost always **no**. A shared orchestrator with per-project overrides covers 95% of real usage. Split only when you have a concrete reason above.

---

## 4. Batch workflows and mixed trackers

### 4a. Using different trackers per project

Each project can use a different tracker plugin. Common mix:

```yaml
projects:
  web:
    repo: org/web
    path: ~/code/web
    tracker:
      plugin: github # GitHub Issues

  platform:
    repo: org/platform
    path: ~/code/platform
    tracker:
      plugin: linear # Linear (needs LINEAR_API_KEY)
      teamId: PLAT

  infra:
    repo: org/infra
    path: ~/code/infra
    tracker:
      plugin: gitlab # GitLab Issues
      projectId: "12345"
```

When you `ao spawn ISSUE`, the tracker plugin for that project fetches issue metadata, determines the branch name, and posts status updates. You don't specify the tracker at spawn time — it's resolved from the project block.

**Issue identifier format depends on the tracker:**

- GitHub: numeric (`123`, `456`) or URL.
- Linear: key (`PLAT-42`) or URL. Branch name follows Linear's "Copy git branch name" when available; falls back to `feat/<issue-id>`.
- GitLab: numeric (`#123`) or URL.

### 4b. Secrets and env vars

Trackers and notifiers that need credentials read them from environment variables, not the YAML:

```bash
# ~/.zshrc or ~/.bashrc
export LINEAR_API_KEY="lin_api_..."
export GITLAB_TOKEN="glpat-..."
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
# GITHUB_TOKEN is typically provided by `gh auth login`
```

`gh` must be authenticated regardless of tracker — AO uses it for PR creation, CI polling, and review comment fetching.

### 4c. Triage workflow across projects

A common pattern: sweep through open issues each morning, batch-spawn per project.

```bash
# Monday morning — triage
cd ~/code/frontend && ao batch-spawn 510 511 512
cd ~/code/backend  && ao batch-spawn PLAT-40 PLAT-41
cd ~/code/mobile   && ao batch-spawn 88 89 90

# Walk away. Check the dashboard an hour later.
```

The orchestrator handles CI failures and review comments automatically (per your `reactions:` config). You get notified when a PR needs a human — merge or clarify.

---

## 5. Dashboard usage

### 5a. The project sidebar

Every project in your config shows up as a section in the dashboard's left sidebar, with its sessions nested underneath. Each session has an **attention dot** that summarizes the next action needed:

| Dot     | Meaning                                 |
| ------- | --------------------------------------- |
| Respond | Waiting on you for input / approval     |
| Review  | PR open, needs review                   |
| Action  | PR approved + green CI — click to merge |
| Working | Agent is doing work right now           |
| Pending | Waiting on CI or polling                |
| Merge   | About to be merged                      |
| Done    | Terminal — archived                     |

The sidebar is the coordination surface. You can scan 30 sessions across 5 projects in under a minute and pick the one or two that need a human.

### 5b. Filtering and scoping

Click a project header to scope the main view to that project. Click again to unscope. Keyboard shortcuts let you jump between projects without the mouse (see the dashboard's `?` menu).

### 5c. Multiple dashboards

If you do run separate orchestrators (§3b), each has its own dashboard. Bookmark them with distinct ports:

```
http://localhost:3000   — work
http://localhost:3100   — personal
http://remote-host:3000 — staging sandbox (over Tailscale)
```

### 5d. Remote access

AO keeps macOS awake via `caffeinate` so you can hit the dashboard from another device on your LAN or Tailscale. Lid-close sleep is a hardware limit — use [clamshell mode](https://support.apple.com/en-us/102505) if you need lid-closed remote access. See the [README → Remote Access](../README.md#remote-access) section for details.

---

## 6. Resource management

Running many agents in parallel costs compute, tokens, and API quota. Plan for it.

### 6a. Concurrent sessions

There is **no hard cap** on concurrent sessions — AO will spawn as many as your config and hardware allow. Practical limits:

- **tmux runtime**: each session is a tmux window + agent process (Node.js / Python). Budget ~500 MB RAM per active Claude Code session, more for long-running agents with large contexts.
- **CPU**: agents are mostly I/O-bound (waiting on API responses), so dozens per machine is viable. CI polling and file I/O are the CPU floor.
- **Disk**: each worktree is a full git checkout. A 500 MB repo × 20 sessions = 10 GB. Use `workspace: clone` only if worktrees don't work for your repo (submodules, LFS edge cases).
- **File descriptors**: on macOS, default ulimit is 256. Raise it (`ulimit -n 4096`) if you see "too many open files" with 20+ sessions.

Sensible starting points:

| Machine                 | Recommended max concurrent sessions |
| ----------------------- | ----------------------------------- |
| 16 GB laptop            | 5–8                                 |
| 32 GB laptop / small VM | 10–15                               |
| 64 GB+ workstation      | 20–40                               |

### 6b. API rate limits

The big ones to know:

- **Anthropic (Claude Code)** — rate-limited per API key. If you're running 20 sessions on one key, expect 429s during peak. The agent plugin retries with backoff, but you'll see pauses.
- **OpenAI (Codex)** — similar, per org.
- **GitHub** — 5,000 requests/hour for authenticated `gh`. AO polls PR status every 30s, which is ~120 req/hour/session. Twenty sessions = 2,400 req/hour. Fine. Forty = you'll hit the limit.
- **Linear** — 1,500 req/hour on the free tier. AO polls issue status; heavy batch-spawns can brush the limit.

Mitigation:

- Use multiple Anthropic / OpenAI keys and rotate via separate orchestrators (§3b) if you exceed a single key's budget.
- For GitHub, the [SCM webhook](../agent-orchestrator.yaml.example) feature pushes events instead of polling — drop-in for high-session deployments.
- For Linear/GitLab, keep tracker reads efficient (don't run `ao status --watch` with 50 sessions; use the dashboard).

### 6c. Cost

Token cost dominates. Two levers:

1. **Model tier.** Configure `agentConfig.model` per project. Use `opus` for the hard repos, `sonnet` or `haiku` for docs / typo / rename passes.
2. **Scope.** Smaller, well-scoped issues = cheaper sessions. A triage task averages $0.50–$2; a multi-file refactor can be $10+. Batch-spawning 50 vague "improve X" tickets is expensive. Spawn 50 specific bugs instead.

The dashboard shows per-session cost when the agent plugin reports it (Claude Code and Codex both do).

### 6d. Cleanup

Completed sessions archive automatically (see `~/.agent-orchestrator/{hash}-{projectId}/archive/`). Stale worktrees from crashed sessions accumulate — run periodically:

```bash
ao doctor --fix
```

This cleans up orphan worktrees, stale tmux sessions, and AO temp files.

---

## 7. Cross-project artifacts and context

Agents in different projects don't share state out of the box. Three patterns for cross-project context:

### 7a. Shared rules file

Put common conventions in a file referenced by each project:

```yaml
projects:
  frontend:
    agentRulesFile: .agent-rules.md # in-repo
  backend:
    agentRulesFile: .agent-rules.md
```

Or reuse the same rules inline via YAML anchors:

```yaml
x-common-rules: &common_rules |
  Use conventional commits.
  Never push to main directly.
  All PRs need tests.

projects:
  frontend:
    agentRules: *common_rules
  backend:
    agentRules: *common_rules
```

### 7b. Orchestrator-level context

The orchestrator agent watches every project in the current config. Use it to hand off tasks between repos ("the frontend change needs a corresponding backend migration") — it can batch-spawn into the right project itself.

### 7c. Artifacts via the filesystem

For design docs, shared schemas, or test fixtures that multiple agents need to reference, keep them in a dedicated repo and add that repo as a project in the config. Agents don't see each other's worktrees, but the orchestrator can copy or symlink files where needed — use `symlinks:` in the project block to link shared files into every workspace:

```yaml
projects:
  backend:
    path: ~/code/backend
    symlinks:
      - ~/code/shared-schemas/api.openapi.yaml
      - ~/code/shared-schemas/proto
```

### 7d. What not to do

- **Don't share worktrees across projects.** Each session needs an isolated checkout; coupling two projects in one worktree defeats the lifecycle manager.
- **Don't use the session archive as a cross-project datastore.** Archives are for audit, not handoff.
- **Don't hand-edit `~/.agent-orchestrator/{hash}-*/`.** That directory is owned by AO; touch only via the CLI or dashboard.

---

## Worked examples

### Example A — Solo dev, three repos

One laptop, one human, three personal projects. Use a single shared orchestrator. See [`examples/multi-project.yaml`](../examples/multi-project.yaml) as a starting template; adapt the tracker and rules per project.

### Example B — Small team, mixed trackers

Frontend on GitHub, platform on Linear, infra on GitLab. Still one orchestrator, with per-project tracker blocks. Share notifications via a single Slack webhook, route by priority so low-value info doesn't page anyone.

### Example C — Agency with client isolation

Client A and client B should never share dashboards or tokens. Two configs in two separate directories (`~/client-a/agent-orchestrator.yaml`, `~/client-b/agent-orchestrator.yaml`), each on its own port, each with its own `GITHUB_TOKEN` / `LINEAR_API_KEY` scoped to that client. Start them independently.

### Example D — Large monorepo

One repo, but you want to parallelize across sub-areas. Keep it as **one project** in the config — the monorepo is the unit of isolation at the git level. Use different `agentRules` per issue via the tracker, and spawn multiple sessions against different issues in parallel. Do **not** define the same repo as multiple project entries.

---

## Troubleshooting

| Symptom                                               | Likely cause                                     | Fix                                                                      |
| ----------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `ao spawn` errors with "Multiple projects configured" | Not in a project path, no `AO_PROJECT_ID`        | `cd` into the repo, or pass project explicitly                           |
| New project not polled after adding to YAML           | `ao start` is covering the old set               | `ao start <new-project>` re-registers, or `ao stop && ao start`          |
| Dashboard shows a project with no sessions            | No sessions spawned yet, or they're all terminal | Spawn one, or check the archive                                          |
| `EADDRINUSE` on second orchestrator                   | Ports collide                                    | Set `port:`, `terminalPort:`, `directTerminalPort:` in the second config |
| Hash collision error on startup                       | Two configs resolve to the same hash             | Move one config to a different directory (rare)                          |
| `gh` rate-limited with 20+ sessions                   | Too many PR/CI polls                             | Enable SCM webhooks (see `agent-orchestrator.yaml.example`)              |

See [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) for more.

---

## See also

- [README](../README.md) — overview and quick start
- [SETUP.md](../SETUP.md) — full install and config reference
- [CLI Reference](CLI.md) — every `ao` command
- [`examples/multi-project.yaml`](../examples/multi-project.yaml) — starter template
- [`agent-orchestrator.yaml.example`](../agent-orchestrator.yaml.example) — full config schema
