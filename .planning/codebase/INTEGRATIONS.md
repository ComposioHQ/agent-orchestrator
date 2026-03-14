# Agent Orchestrator Integrations

## Integration model
- Integration slots are defined in `packages/core/src/types.ts`: runtime, agent, workspace, tracker, SCM, notifier, and terminal.
- Built-in plugin names and package bindings are declared in `packages/core/src/plugin-registry.ts`.
- Project-level integration config is validated in `packages/core/src/config.ts`.

## Source control and issue trackers
- GitHub SCM integration is implemented in `packages/plugins/scm-github/src/index.ts`.
- GitHub tracker integration is implemented in `packages/plugins/tracker-github/src/index.ts`.
- GitLab SCM integration is implemented in `packages/plugins/scm-gitlab/src/index.ts`.
- GitLab tracker integration is implemented in `packages/plugins/tracker-gitlab/src/index.ts`.
- Linear tracker integration is implemented in `packages/plugins/tracker-linear/src/index.ts`.
- The web dashboard only statically registers GitHub SCM, GitHub tracker, and Linear tracker in `packages/web/src/lib/services.ts`; GitLab is available in the monorepo but not statically wired into the web singleton there.

## External APIs and network services
- GitHub integrations primarily shell out to the `gh` CLI in `packages/plugins/scm-github/src/index.ts` and `packages/plugins/tracker-github/src/index.ts`.
- GitLab integrations primarily shell out to the `glab` CLI via helpers in `packages/plugins/scm-gitlab/src/glab-utils.ts`.
- Linear uses direct HTTPS GraphQL requests to `https://api.linear.app/graphql` in `packages/plugins/tracker-linear/src/index.ts`.
- Linear can also route through the Composio SDK tool `LINEAR_RUN_QUERY_OR_MUTATION` in `packages/plugins/tracker-linear/src/index.ts`.
- Slack notifications send outbound HTTP POST requests with `fetch()` in `packages/plugins/notifier-slack/src/index.ts`.
- Generic webhook notifications send outbound HTTP POST requests with retries in `packages/plugins/notifier-webhook/src/index.ts`.
- OpenClaw notifications send outbound HTTP POST requests to a local/default hook endpoint in `packages/plugins/notifier-openclaw/src/index.ts`.
- Composio notifications call SDK actions like `SLACK_SEND_MESSAGE`, `DISCORD_SEND_MESSAGE`, and `GMAIL_SEND_EMAIL` in `packages/plugins/notifier-composio/src/index.ts`.
- The Codex app-server client launches a local JSON-RPC subprocess, not a remote HTTP API, in `packages/plugins/agent-codex/src/app-server-client.ts`.

## Incoming webhook surfaces
- SCM webhook request matching and project routing are implemented in `packages/web/src/lib/scm-webhooks.ts`.
- The Next.js webhook entrypoint is `packages/web/src/app/api/webhooks/[...slug]/route.ts`.
- GitHub webhook defaults are `/api/webhooks/github`, `x-hub-signature-256`, `x-github-event`, and `x-github-delivery`; see `packages/plugins/scm-github/src/index.ts`.
- GitLab webhook defaults are `/api/webhooks/gitlab`, `x-gitlab-token`, `x-gitlab-event`, and `x-gitlab-event-uuid`; see `packages/plugins/scm-gitlab/src/index.ts`.
- Both SCM plugins optionally verify secrets from an env var named by `project.scm.webhook.secretEnvVar`; see `packages/plugins/scm-github/src/index.ts` and `packages/plugins/scm-gitlab/src/index.ts`.
- Webhook payload size limiting is enforced in `packages/web/src/app/api/webhooks/[...slug]/route.ts` using per-project `maxBodyBytes`.

## Browser, websocket, and runtime integration
- Web dashboard APIs live under `packages/web/src/app/api/`.
- Session spawn/send/kill/restore HTTP routes are consumed by the web UI and mobile client; see `packages/web/src/components/Dashboard.tsx` and `packages/mobile/src/context/BackendContext.tsx`.
- Ttyd-based terminal proxying is implemented in `packages/web/server/terminal-websocket.ts`.
- Direct PTY-to-browser terminal websocket integration is implemented in `packages/web/server/direct-terminal-ws.ts`.
- The browser-side direct terminal client is `packages/web/src/components/DirectTerminal.tsx`.
- The terminal-web plugin only publishes dashboard URLs and does not itself host sockets; see `packages/plugins/terminal-web/src/index.ts`.

## Local CLIs and OS integrations
- `tmux` is the default runtime dependency; runtime implementation is in `packages/plugins/runtime-tmux/src/index.ts`.
- `git` is used by workspace plugins in `packages/plugins/workspace-worktree/src/index.ts` and `packages/plugins/workspace-clone/src/index.ts`.
- `gh` is required for GitHub SCM/tracker behavior and preflight auth checks in `packages/cli/src/lib/preflight.ts`.
- `glab` is required for GitLab SCM/tracker behavior in `packages/plugins/scm-gitlab/src/glab-utils.ts`.
- `ttyd` is spawned by `packages/web/server/terminal-websocket.ts`.
- `node-pty` is used by `packages/web/server/direct-terminal-ws.ts` and declared in `packages/web/package.json`.
- macOS iTerm2 integration uses `osascript` in `packages/plugins/terminal-iterm2/src/index.ts`.
- Desktop notifications use `osascript` on macOS and `notify-send` on Linux in `packages/plugins/notifier-desktop/src/index.ts`.

## Agent tool integrations
- Claude Code agent integration is implemented in `packages/plugins/agent-claude-code/src/index.ts`.
- Codex CLI integration is implemented in `packages/plugins/agent-codex/src/index.ts`.
- OpenCode agent integration is implemented in `packages/plugins/agent-opencode/src/index.ts`.
- Aider integration is implemented in `packages/plugins/agent-aider/src/index.ts`.
- Claude Code and Codex both install shell wrappers/hooks that intercept `git` and `gh` activity to update AO metadata; see `packages/plugins/agent-claude-code/src/index.ts` and `packages/plugins/agent-codex/src/index.ts`.

## Credential and auth surfaces
- `AO_CONFIG_PATH` overrides config file discovery in `packages/core/src/config.ts`.
- `LINEAR_API_KEY` authorizes direct Linear GraphQL calls in `packages/plugins/tracker-linear/src/index.ts`.
- `COMPOSIO_API_KEY` and optional `COMPOSIO_ENTITY_ID` enable Composio-backed Linear transport in `packages/plugins/tracker-linear/src/index.ts`.
- `COMPOSIO_API_KEY` also powers the notifier-composio plugin in `packages/plugins/notifier-composio/src/index.ts`.
- `OPENCLAW_HOOKS_TOKEN` is the fallback bearer token for the OpenClaw notifier in `packages/plugins/notifier-openclaw/src/index.ts`.
- GitHub/GitLab webhook shared secrets are loaded indirectly from env vars specified in YAML config, not from hard-coded variable names, in `packages/plugins/scm-github/src/index.ts` and `packages/plugins/scm-gitlab/src/index.ts`.
- Slack webhook URLs, OpenClaw URLs/tokens, generic webhook URLs/headers, and Composio notifier settings are passed via `config.notifiers` and extracted by `packages/core/src/plugin-registry.ts`.
- `GH_PATH`, `AO_DATA_DIR`, and `AO_SESSION` are used by the Codex metadata wrappers in `packages/plugins/agent-codex/src/index.ts`.

## Configurable notifier surfaces
- Slack notifier accepts webhook URL, channel, and username from config in `packages/plugins/notifier-slack/src/index.ts`.
- Generic webhook notifier accepts `url`, custom `headers`, retries, and delay settings in `packages/plugins/notifier-webhook/src/index.ts`.
- OpenClaw notifier accepts `url`, `token`, `name`, `sessionKeyPrefix`, `wakeMode`, and `deliver` in `packages/plugins/notifier-openclaw/src/index.ts`.
- Composio notifier accepts `defaultApp`, `channelId`, `channelName`, and `emailTo` in `packages/plugins/notifier-composio/src/index.ts`.
- Desktop notifier accepts `sound` in `packages/plugins/notifier-desktop/src/index.ts`.

## Workspace and repo access integrations
- Worktree mode creates git worktrees under a configurable base dir in `packages/plugins/workspace-worktree/src/index.ts`.
- Clone mode creates git clones under a configurable base dir in `packages/plugins/workspace-clone/src/index.ts`.
- `postCreate` shell commands from YAML are executed with `sh -c` in both workspace plugins, so that config is a code-execution surface.
- Project `symlinks` and repo path settings are consumed by core/session management code rooted in `packages/core/src/types.ts` and `packages/core/src/config.ts`.

## Web and mobile consumer integrations
- Mobile app stores a backend URL and terminal websocket override in AsyncStorage in `packages/mobile/src/context/BackendContext.tsx`.
- Mobile defaults to talking to `http://192.168.1.1:3000` and derives websocket connections from that base URL in `packages/mobile/src/context/BackendContext.tsx`.
- Mobile background polling hits `/api/sessions` on the configured backend in `packages/mobile/src/notifications/backgroundTask.ts`.
- Android mobile config explicitly allows cleartext traffic in `packages/mobile/app.json`.

## Operational checks and setup scripts
- `ao doctor` delegates to `scripts/ao-doctor.sh` via `packages/cli/src/commands/doctor.ts`.
- `ao update` delegates to `scripts/ao-update.sh` via `packages/cli/src/commands/update.ts`.
- CLI preflight checks validate `tmux`, compiled packages, free dashboard port, and `gh auth status` in `packages/cli/src/lib/preflight.ts`.
- Repo bootstrap/update helper scripts are kept in `scripts/`, including `setup.sh`, `notify-session`, `open-iterm-tab`, and AO-specific launcher helpers.

## Security-relevant docs and examples
- Secret-handling guidance is documented in `SECURITY.md`.
- Example config showing notifier and webhook fields lives in `agent-orchestrator.yaml.example`.
- Additional integration examples live in `examples/linear-team.yaml`, `examples/codex-integration.yaml`, and `examples/multi-project.yaml`.
