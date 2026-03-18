# Container Deployment

This guide covers running Agent Orchestrator as a container with the root [compose.yaml](compose.yaml) and [Containerfile](Containerfile).

Use this path when you want the orchestrator itself to stay inside Docker or Podman while your repos and state live on mounted volumes.

## Before You Start

- Install Docker or Podman with Compose support.
- Clone this repository locally.
- Create a host directory for projects. By default the compose file uses `./projects`.
- If you need private GitHub access, authenticate `gh` on the host and mount that state.
- If you need Kubernetes access, place a kubeconfig in `./.kube/config` or point `KUBECONFIG_DIR` elsewhere.

## Quick Start

### First run

1. Create the host projects directory:

```bash
mkdir -p projects
```

2. Choose one bootstrap path:

Generate a shared config interactively:

```bash
podman compose run --rm agent-orchestrator init
```

Or clone a repo and bootstrap from it:

```bash
podman compose run --rm agent-orchestrator start your-org/your-repo
```

3. Start the long-running service:

```bash
podman compose up
```

The dashboard is available at `http://localhost:3000`.

### What each bootstrap path does

`init`:

- creates `./projects/agent-orchestrator.yaml`
- lets you define one or more projects manually

`start your-org/your-repo`:

- clones into `./projects/<repo>`
- writes the shared config to `./projects/agent-orchestrator.yaml`
- starts the orchestrator for that repo immediately

After the first run, normal usage is just:

```bash
podman compose up
```

GitHub shorthand and full URLs both work:

```bash
podman compose run --rm agent-orchestrator start your-org/your-repo
podman compose run --rm agent-orchestrator start https://github.com/your-org/your-repo
podman compose run --rm agent-orchestrator start git@github.com:your-org/your-repo.git
```

Docker uses the same command shape with `docker compose`.

## Running the Image Directly

The image entrypoint is `ao`, so `docker run` and `podman run` behave like the normal CLI.

Minimal example:

```bash
docker run --rm -it \
  -p 3000:3000 \
  -p 14800:14800 \
  -p 14801:14801 \
  -v "$(pwd)/projects:/projects" \
  -v ao-data:/root/.agent-orchestrator \
  ghcr.io/composiohq/agent-orchestrator:latest \
  start your-org/your-repo
```

Podman:

```bash
podman run --rm -it \
  -p 3000:3000 \
  -p 14800:14800 \
  -p 14801:14801 \
  -v "$(pwd)/projects:/projects" \
  -v ao-data:/root/.agent-orchestrator \
  ghcr.io/composiohq/agent-orchestrator:latest \
  start your-org/your-repo
```

## Useful Mounts

The default compose file already includes these mounts:

- `${AO_PROJECTS_DIR:-./projects}` -> `/projects`
- `${GH_CONFIG_DIR:-./.gh}` -> `/root/.config/gh`
- `${KUBECONFIG_DIR:-./.kube}` -> `/root/.kube`
- `ao-data` -> `/root/.agent-orchestrator`

What they are for:

- `/projects`: cloned repos and the shared config file
- `/root/.config/gh`: GitHub CLI auth state for private repos and PR workflows
- `/root/.kube`: kubeconfig for Kubernetes access
- `/root/.agent-orchestrator`: AO session metadata

If you do not need GitHub auth or Kubernetes access, those host directories can stay empty.

## Mental Model

The container always works from `/projects`.

- Host projects directory: `./projects` by default
- Container projects directory: `/projects`
- Default container config path: `/projects/agent-orchestrator.yaml`

Important: project paths inside `agent-orchestrator.yaml` must use container paths, not host paths.

Example:

```yaml
projects:
  my-app:
    repo: your-org/my-app
    path: /projects/my-app
    defaultBranch: main
```

## Common Commands

Start the long-running service:

```bash
docker compose up
```

Run one-off commands inside the service image:

```bash
docker compose run --rm agent-orchestrator init
docker compose run --rm agent-orchestrator start your-org/your-repo
docker compose run --rm agent-orchestrator status
```

Run commands against the already running container:

```bash
docker compose exec agent-orchestrator ao status
docker compose exec agent-orchestrator ao spawn my-app 123
```

Podman uses the same command shape with `podman compose`.

## Image Build Options

Build locally:

```bash
docker compose build
```

To control which coding CLIs are installed in the image, set `AO_INSTALL_AGENTS` before building.

Example:

```bash
AO_INSTALL_AGENTS=codex docker compose build
```

If you prefer not to build locally, change the service image to:

```yaml
image: ghcr.io/composiohq/agent-orchestrator:latest
```

## Troubleshooting

### `No config found. Run: ao init`

Create the shared config first:

```bash
docker compose run --rm agent-orchestrator init
```

Or bootstrap from a repo URL:

```bash
docker compose run --rm agent-orchestrator start your-org/your-repo
```

### The config exists but projects look empty

Check that each project path in `agent-orchestrator.yaml` uses `/projects/...`, not a host path like `~/my-app`.

### I changed the image or build args but nothing changed

Rebuild explicitly:

```bash
docker compose build --no-cache
```

### I want to inspect the generated config

The default location is:

```bash
./projects/agent-orchestrator.yaml
```
