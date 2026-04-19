# Multi-Project Dashboard Guide

AO supports a global multi-project portfolio. Your projects are tracked centrally
in `~/.agent-orchestrator/config.yaml`, each repo keeps its own
`agent-orchestrator.yaml` for repo-specific behavior, and the dashboard, sidebar,
and CLI all share the same project registry.

> Portfolio mode is on by default. To opt out (fall back to the single-project
> dashboard and disable `ao project` / `ao spawn --project`), set
> `AO_ENABLE_PORTFOLIO=0` in your shell.

---

## For Existing Users

### What Changes After Upgrading

The main visible change: **the root URL (`/`) now shows a portfolio overview**
instead of the single-project session list. Your project dashboard moves to
`/projects/<project-id>`.

Existing repos do not all appear in the portfolio automatically on upgrade day.
A repo gets added when you first use it after upgrading — either by running
`ao start` or by opening it in the dashboard.

### Migration Flow

When you run `ao start` inside an existing repo:

1. AO detects the old config format (a `projects:` wrapper with `path` fields)
2. AO migrates automatically:
   - Creates global config at `~/.agent-orchestrator/config.yaml`
   - Rewrites local config to flat format (behavior fields only)
   - Registers the repo in the global portfolio
3. The orchestrator starts and the dashboard opens

If the old config is ambiguous, AO stops and shows exactly what needs fixing.
In normal cases, no manual config rewrite is needed.

### Migration via the Dashboard

Open the dashboard and choose **Open Project** from the sidebar. AO will:

- Inspect the selected directory
- Migrate older config automatically if needed
- Register the project in the global portfolio
- Navigate to the project page
- Start the main orchestrator

### Legacy URL Handling

Old bookmarks to `/sessions/<id>` still work. AO redirects them to the new
path `/projects/<project-id>/sessions/<id>` by looking up the session across
all portfolio projects.

---

## For New Users

### First Launch

Run `ao start` inside any git repo (or a new folder). AO will:

1. Detect the environment (git, language, frameworks)
2. Generate `agent-orchestrator.yaml` with smart defaults
3. Register the project in the global portfolio
4. Start the orchestrator and open the dashboard

On first visit, the dashboard shows a **launcher screen** with two options:

- **Open project** — register an existing local directory
- **Clone from URL** — clone a repository and register it

Once you add your first project, the launcher is replaced by the **portfolio
overview** showing all your projects at a glance.

### Ways to Add a Project

You can start with:

- An existing git repo with a remote
- A local repo without a remote
- An empty folder

AO handles all three. It generates a config, registers the project, and starts
the orchestrator.

---

## Dashboard Navigation

### URL Scheme

| Path | What It Shows |
|------|---------------|
| `/` | Portfolio overview — project cards with attention summaries |
| `/projects/<id>` | Single project dashboard — session list and controls |
| `/projects/<id>/sessions/<id>` | Session detail — terminal output, PR info, actions |
| `/activity` | Cross-project activity feed |
| `/prs` | Cross-project pull requests view |
| `/settings` | Portfolio and agent settings |
| `/sessions/<id>` | Legacy redirect → `/projects/<id>/sessions/<id>` |

### Portfolio Home (`/`)

Shows when you have registered projects:

- **Header**: "Portfolio" with active/total session counts
- **Attention pills**: aggregate counts across all projects — merge, respond,
  review, pending, working
- **Project cards**: grid of all projects, each showing name, repo, session
  ratio (active/total), and colored attention badges
- **Degraded projects**: if a repo's local `agent-orchestrator.yaml` becomes
  invalid, the project still appears in the portfolio with a degraded state
  instead of disappearing or crashing the dashboard
- Click any card to go to that project's dashboard

When no projects are registered, shows the launcher screen instead.

### Project Dashboard (`/projects/<id>`)

- Full session list for this project (excludes orchestrator sessions)
- Stats bar: total sessions, working, open PRs, needs review
- Session cards with status, PR info, CI checks, review state
- Global pause controls
- If the project is degraded, the page shows the config error and blocks
  project-scoped actions until the local config is fixed
- Invalid project IDs return a 404 page

### Session Detail (`/projects/<id>/sessions/<id>`)

- Session status badge (working, review, respond, merge, done, etc.)
- Terminal output (live or recorded)
- PR details card with CI status, review decision, merge state
- Action buttons: kill, send message, restore, remap

If a project's config becomes degraded, historical sessions may still be listed,
but new project-scoped mutations are blocked until the config resolves cleanly.

### Activity Feed (`/activity`)

- Cross-project view of recent session events
- Action items requiring human attention
- Sorted by urgency

### Pull Requests (`/prs`)

- All PRs from agent sessions across all projects
- Filterable by project via `?project=<id>` query parameter
- PR cards with title, CI status, review decision, merge status

### Sidebar (present on all pages)

The sidebar appears on every page and provides:

- **Activity link** — highlighted when on `/` or `/activity`
- **Workspaces section** — all portfolio projects with:
  - Color avatars
  - Attention pills (e.g. "2r 1w" for 2 respond, 1 working)
  - Click to navigate to project dashboard
  - Hover actions: view resources, spawn agent, remove project
- **Agents section** — currently active (non-done) sessions across all projects
- **Footer** — theme toggle and settings link
- **Add button** (+) — opens the "Open project" modal
- **Filter/sort** — group by repo or status, filter by specific project or status
- **Drag to reorder** — reorder projects by dragging (persisted via preferences API)
- **Collapsible** — toggle to icon-only view; resizable with mouse drag
- **Mobile** — hamburger menu on small screens

---

## Spawning Agents

### From the Sidebar

Hover over any project → click the **+** button → select an agent:

- Only agents that are actually installed appear in the menu
- Available agents are loaded from the plugin registry (`GET /api/agents`)
- Common agents: Claude Code, Open Code, Codex

After spawning, you're redirected to the new session page.

### From the CLI

```bash
ao spawn --project <project-id>
ao spawn --project <project-id> --agent claude-code
ao spawn --project <project-id> --issue 42
ao spawn --project <project-id> --prompt "Fix the login bug"
```

### Workspace Resources

Hover over a project → click the **link icon** to open the resources modal:

- **Pull Requests** — open PRs in the repo
- **Branches** — all branches
- **Issues** — open issues

Click any resource to spawn an agent session targeting it.

---

## Project Management

### Adding Projects

**Dashboard**: click the **+** button in the sidebar → "Open project" → browse
to directory → submit.

The dashboard registers the project and reloads portfolio state in place, so
you do not need to restart AO or manually refresh the page.

**CLI**:
```bash
ao project add /path/to/project
ao project add /path/to/project -k custom-key
```

### Removing Projects

**Dashboard**: hover over a project in the sidebar → click the trash icon →
confirm. The directory is not deleted from disk.

**CLI**:
```bash
ao project rm <project-id>
```

### Editing Project Behavior

Open **Settings** to update per-project behavior fields such as:

- `repo`
- `defaultBranch`

Identity-owned fields like project ID, path, session prefix, and storage key are
not editable from the dashboard settings flow.

### Degraded Projects

If a registered repo's local `agent-orchestrator.yaml` is missing or invalid:

- The project remains visible in the portfolio
- The dashboard and settings page show the degraded reason
- Spawn/recovery/project-scoped mutation actions are blocked
- You can still remove the project from the portfolio

This is deliberate: one broken repo should not take down the rest of the
portfolio.

### Reordering Projects

Drag projects in the sidebar to reorder. The order is persisted and applies
across sessions.

### Other CLI Commands

```bash
ao project ls                    # List all portfolio projects
ao project set-default <id>      # Set the default project
ao dashboard                     # Open the web dashboard
ao dashboard --project <id>      # Open directly to a project page
```

---

## Configuration Architecture

### Two-Layer Config

| Layer | Path | Contains |
|-------|------|----------|
| Global | `~/.agent-orchestrator/config.yaml` | Project identity (name, path), portfolio membership, shadow behavior fields |
| Local | `<repo>/agent-orchestrator.yaml` | Repo-specific behavior (agent, runtime, workspace, repo, tracker, scm, etc.) |

The global config is the source of truth for "which projects exist." The local
config is the source of truth for "how this project behaves."

### Global Config Location

Resolved in this order:

1. `$AO_GLOBAL_CONFIG` environment variable
2. `$XDG_CONFIG_HOME/agent-orchestrator/config.yaml`
3. `~/.agent-orchestrator/config.yaml`

### Shadow Sync

Every `ao start` syncs behavior fields from the local config into the global
config as a "shadow." This lets the dashboard show project details without
reading every local config on disk. The shadow is refreshed when the local
config file is newer than `_shadowSyncedAt`.

### Other Storage

| Path | Purpose |
|------|---------|
| `~/.agent-orchestrator/portfolio/preferences.json` | Project order, default project, pin states |
| `~/.agent-orchestrator/<hash>-<projectId>/sessions/` | Per-project session data |

---

## API Reference

### Projects

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects` | List all projects |
| GET | `/api/projects?scope=portfolio` | List with portfolio metadata (pinned, degraded, etc.) |
| POST | `/api/projects` | Register a project `{ path, name? }` |
| PUT | `/api/projects/<id>` | Update preferences `{ pinned?, enabled?, displayName? }` |
| PATCH | `/api/projects/<id>` | Update behavior fields such as `{ repo?, defaultBranch?, runtime?, agent?, workspace? }` |
| DELETE | `/api/projects/<id>` | Remove from portfolio |
| POST | `/api/projects/reload` | Reload services and portfolio state after project changes |
| GET | `/api/projects/<id>/resources` | Get PR/branch/issue resources |

### Sessions

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List sessions (single project) |
| GET | `/api/sessions?scope=portfolio` | List all sessions across projects |
| GET | `/api/sessions?project=<id>` | Filter to one project |
| GET | `/api/sessions/<id>` | Session detail |
| POST | `/api/sessions/<id>/kill` | Kill session |
| POST | `/api/sessions/<id>/send` | Send message to session |
| POST | `/api/sessions/<id>/restore` | Restore session |
| POST | `/api/sessions/<id>/remap` | Remap session to different PR/issue |

### Other

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/spawn` | Spawn new session `{ projectId, agent?, issueId?, prompt? }` |
| GET | `/api/agents` | List available agent plugins |
| PUT | `/api/settings/preferences` | Update project order, default project |
| GET | `/api/browse-directory?path=<dir>` | Browse filesystem for project picker |
