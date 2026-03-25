# Docker Setup for Agent Orchestrator

Run the full Agent Orchestrator development environment in Docker containers.

## Services

| Service | Description | Ports |
|---------|-------------|-------|
| **core** | Core library (`@composio/ao-core`) — types, config, session manager | — |
| **web** | Next.js dashboard + terminal WebSocket servers | 3000, 14800, 14801 |
| **cli** | CLI tool (`@composio/ao-cli`) with tmux and git — use via `docker compose exec` | — |

## Quick Start

```bash
# 1. Copy environment config (optional — defaults work out of the box)
cp .env.docker .env

# 2. Start all services in development mode
docker compose up

# 3. Open the dashboard
open http://localhost:3000
```

## Common Commands

```bash
# Start all services (foreground)
docker compose up

# Start all services (background)
docker compose up -d

# Start a specific service
docker compose up web

# Rebuild after dependency changes (e.g. new packages in package.json)
docker compose up --build

# Stop all services
docker compose down

# View logs
docker compose logs -f web

# Run CLI commands
docker compose exec cli pnpm dev -- status

# Run core tests
docker compose exec core pnpm test

# Shell into a service
docker compose exec web sh
```

## Development Workflow

### Hot Reload

All services mount source directories as volumes, so code changes are picked up automatically:

- **core**: `packages/core/src/` is mounted — changes trigger test re-runs
- **web**: `packages/web/src/` and `packages/web/server/` are mounted — Next.js hot reloads. Note: changes to `@composio/ao-core` require `docker compose up --build` since web resolves core from its built `dist/`
- **cli**: `packages/cli/src/` is mounted — run commands via `docker compose exec cli pnpm dev -- <command>`

### Rebuilding

If you change `package.json`, `pnpm-lock.yaml`, or any build configuration:

```bash
docker compose up --build
```

### Running Tests

```bash
# Core unit tests
docker compose exec core pnpm test

# Web unit tests
docker compose exec web pnpm test

# CLI unit tests
docker compose exec cli pnpm test
```

## Environment Variables

Configuration is done via `.env` (copy from `.env.docker`):

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_PORT` | `3000` | Host port for the web dashboard |
| `TERMINAL_PORT` | `14800` | Host port for the ttyd terminal WebSocket (also sets browser-side `NEXT_PUBLIC_TERMINAL_PORT`) |
| `DIRECT_TERMINAL_PORT` | `14801` | Host port for the direct terminal WebSocket (also sets browser-side `NEXT_PUBLIC_DIRECT_TERMINAL_PORT`) |
| `NODE_ENV` | `development` | Node environment |

## Production Build

To build production images:

```bash
# Build production web image
docker build -f docker/web/Dockerfile --target prod -t ao-web:prod .

# Build production CLI image
docker build -f docker/cli/Dockerfile --target prod -t ao-cli:prod .

# Run production web
docker run -p 3000:3000 -p 14800:14800 -p 14801:14801 ao-web:prod

# Run production CLI
docker run ao-cli:prod status
```

## Architecture

```
docker-compose.yml          # Service orchestration
.dockerignore               # Build context exclusions
.env.docker                 # Default environment template
docker/
  core/Dockerfile           # Multi-stage: base → dev / build → prod
  web/Dockerfile            # Multi-stage: base → dev / build → prod
  cli/Dockerfile            # Multi-stage: base → dev / build → prod
```

Each Dockerfile uses multi-stage builds with three targets:
- **dev**: Full development environment with hot reload
- **build**: Intermediate build stage
- **prod**: Minimal production image with compiled output only

All containers run as a non-root `aouser` for security.

## Troubleshooting

### Port conflicts

If port 3000 is already in use, change `WEB_PORT` in `.env`:

```bash
WEB_PORT=3001 docker compose up
```

### node-pty build failures

The web service requires native compilation for `node-pty`. The Dockerfile includes build tools (`python3`, `make`, `g++`). If you still see failures, try:

```bash
docker compose build --no-cache web
```

### Permission issues

The containers run as `aouser` (non-root). If you see permission errors on mounted volumes, ensure the host directories are readable:

```bash
chmod -R a+r packages/
```

### Stale containers

```bash
docker compose down --volumes --remove-orphans
docker compose up --build
```
