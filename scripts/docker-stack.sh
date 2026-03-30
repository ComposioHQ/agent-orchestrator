#!/usr/bin/env bash
set -euo pipefail

# docker-stack.sh — per-session Docker Compose stack management
#
# Usage:
#   scripts/docker-stack.sh up      # Allocate ports, build, start stack
#   scripts/docker-stack.sh down    # Tear down stack and clean up
#   scripts/docker-stack.sh status  # Show running containers
#   scripts/docker-stack.sh ports   # Print allocated ports as JSON
#
# Environment:
#   AO_SESSION          — session ID (required, used as compose project name)
#   AO_WORKSPACE_PATH   — worktree root (optional, defaults to cwd)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="${AO_WORKSPACE_PATH:-$(pwd)}"
SESSION="${AO_SESSION:?AO_SESSION is required}"
PROJECT_NAME="ao-${SESSION}"
ENV_FILE="${WORKSPACE}/.ao/docker.env"
PORTS_FILE="${WORKSPACE}/.ao/docker-ports.json"
COMPOSE_FILE="${WORKSPACE}/docker-compose.yml"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "error: docker-compose.yml not found at ${COMPOSE_FILE}" >&2
  exit 1
fi

# Find a free TCP port using Python (available on all dev machines)
find_free_port() {
  python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()"
}

cmd_up() {
  mkdir -p "${WORKSPACE}/.ao"

  # Allocate ports if not already done
  if [[ -f "$PORTS_FILE" ]]; then
    echo "Reusing existing port allocation from ${PORTS_FILE}"
    WEB_PORT=$(python3 -c "import json; print(json.load(open('${PORTS_FILE}'))['webPort'])")
    TERMINAL_PORT=$(python3 -c "import json; print(json.load(open('${PORTS_FILE}'))['terminalPort'])")
    DIRECT_TERMINAL_PORT=$(python3 -c "import json; print(json.load(open('${PORTS_FILE}'))['directTerminalPort'])")
  else
    WEB_PORT=$(find_free_port)
    TERMINAL_PORT=$(find_free_port)
    DIRECT_TERMINAL_PORT=$(find_free_port)

    # Persist ports
    cat > "$PORTS_FILE" <<JSONEOF
{"webPort":${WEB_PORT},"terminalPort":${TERMINAL_PORT},"directTerminalPort":${DIRECT_TERMINAL_PORT}}
JSONEOF
    echo "Allocated ports: web=${WEB_PORT} terminal=${TERMINAL_PORT} direct=${DIRECT_TERMINAL_PORT}"
  fi

  # Write env file for compose
  cat > "$ENV_FILE" <<ENVEOF
WEB_PORT=${WEB_PORT}
TERMINAL_PORT=${TERMINAL_PORT}
DIRECT_TERMINAL_PORT=${DIRECT_TERMINAL_PORT}
NEXT_PUBLIC_TERMINAL_PORT=${TERMINAL_PORT}
NEXT_PUBLIC_DIRECT_TERMINAL_PORT=${DIRECT_TERMINAL_PORT}
NODE_ENV=development
ENVEOF

  echo "Starting stack '${PROJECT_NAME}' from ${WORKSPACE}..."
  docker compose \
    -p "$PROJECT_NAME" \
    -f "$COMPOSE_FILE" \
    --env-file "$ENV_FILE" \
    up -d --build

  echo ""
  echo "Stack '${PROJECT_NAME}' is up:"
  echo "  Web dashboard:  http://localhost:${WEB_PORT}"
  echo "  Terminal WS:    ws://localhost:${TERMINAL_PORT}"
  echo "  Direct WS:      ws://localhost:${DIRECT_TERMINAL_PORT}"
  echo "  Ports file:     ${PORTS_FILE}"
  echo ""
  echo "To check: AO_SESSION=${SESSION} scripts/docker-stack.sh status"
  echo "To stop:  AO_SESSION=${SESSION} scripts/docker-stack.sh down"
}

cmd_down() {
  if [[ -f "$ENV_FILE" ]]; then
    echo "Tearing down stack '${PROJECT_NAME}'..."
    docker compose \
      -p "$PROJECT_NAME" \
      -f "$COMPOSE_FILE" \
      --env-file "$ENV_FILE" \
      down --volumes --remove-orphans 2>/dev/null || true
    rm -f "$ENV_FILE" "$PORTS_FILE"
    echo "Stack '${PROJECT_NAME}' removed."
  else
    # Try without env file (best effort cleanup)
    docker compose -p "$PROJECT_NAME" down --volumes --remove-orphans 2>/dev/null || true
    rm -f "$PORTS_FILE"
    echo "Stack '${PROJECT_NAME}' removed (no env file found, best-effort)."
  fi
}

cmd_status() {
  docker compose -p "$PROJECT_NAME" ps 2>/dev/null || echo "No stack running for '${PROJECT_NAME}'"
}

cmd_ports() {
  if [[ -f "$PORTS_FILE" ]]; then
    cat "$PORTS_FILE"
  else
    echo "null"
  fi
}

case "${1:-help}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  ports)  cmd_ports ;;
  *)
    echo "Usage: $0 {up|down|status|ports}"
    echo ""
    echo "Manages a per-session Docker Compose stack."
    echo "Requires AO_SESSION env var."
    exit 1
    ;;
esac
