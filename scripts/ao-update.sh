#!/bin/bash

set -euo pipefail

SKIP_SMOKE=false
SMOKE_ONLY=false
TARGET_BRANCH="${AO_UPDATE_BRANCH:-main}"

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-smoke)
      SKIP_SMOKE=true
      ;;
    --smoke-only)
      SMOKE_ONLY=true
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ao update [--skip-smoke] [--smoke-only]

Fast-forwards the local Agent Orchestrator install repo to main, installs deps,
clean-rebuilds critical packages, refreshes the ao launcher, and runs smoke tests.

Options:
  --skip-smoke  Skip smoke tests after rebuild
  --smoke-only  Run smoke tests without fetching or rebuilding
EOF
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$SKIP_SMOKE" = true ] && [ "$SMOKE_ONLY" = true ]; then
  printf 'Conflicting options: use either --skip-smoke or --smoke-only, not both.\n' >&2
  exit 1
fi

REPO_ROOT="${AO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

require_command() {
  local name="$1"
  local fix_hint="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf 'Missing required command: %s. Fix: %s\n' "$name" "$fix_hint" >&2
    exit 1
  fi
}

run_cmd() {
  printf -- '-> %s\n' "$*"
  "$@"
}

run_smoke_tests() {
  printf '\nRunning smoke tests...\n'
  run_cmd node "$REPO_ROOT/packages/agent-orchestrator/bin/ao.js" --version
  run_cmd node "$REPO_ROOT/packages/agent-orchestrator/bin/ao.js" doctor --help
  run_cmd node "$REPO_ROOT/packages/agent-orchestrator/bin/ao.js" update --help
}

ensure_repo_clean() {
  local reason="$1"
  local status_output
  status_output="$(git status --porcelain)"
  if [ -n "$status_output" ]; then
    printf '%s\n' "$reason" >&2
    exit 1
  fi
}

ensure_on_target_branch() {
  local current_branch
  current_branch="$(git branch --show-current)"
  if [ "$current_branch" != "$TARGET_BRANCH" ]; then
    printf 'Current branch is %s, expected %s. Fix: git switch %s && rerun ao update.\n' \
      "$current_branch" "$TARGET_BRANCH" "$TARGET_BRANCH" >&2
    exit 1
  fi
}

printf 'Agent Orchestrator Update\n\n'

require_command node "install Node.js 20+"

cd "$REPO_ROOT"

if [ "$SMOKE_ONLY" = false ]; then
  require_command git "install git 2.25+"
  require_command pnpm "enable corepack or run npm install -g pnpm"
  require_command npm "install npm with Node.js"

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'The update command must run inside the Agent Orchestrator git checkout.\n' >&2
    exit 1
  fi

  ensure_repo_clean "Working tree is dirty. Fix: commit or stash local changes before running ao update."
  ensure_on_target_branch

  run_cmd git fetch origin "$TARGET_BRANCH"
  run_cmd git pull --ff-only origin "$TARGET_BRANCH"
  run_cmd pnpm install

  run_cmd pnpm --filter @composio/ao-core clean
  run_cmd pnpm --filter @composio/ao-cli clean
  run_cmd pnpm --filter @composio/ao-web clean

  run_cmd pnpm --filter @composio/ao-core build
  run_cmd pnpm --filter @composio/ao-cli build
  run_cmd pnpm --filter @composio/ao-web build

  printf '\nRefreshing ao launcher...\n'
  # Ensure npm global prefix is user-writable (shared logic — single source of truth)
  # shellcheck source=./ensure-npm-prefix.sh
  source "$(dirname "${BASH_SOURCE[0]}")/ensure-npm-prefix.sh"
  (cd "$REPO_ROOT/packages/ao" && npm link)

  ensure_repo_clean "Update modified tracked files. Inspect git status, review the changes, and rerun after restoring a clean checkout if needed."
fi

if [ "$SKIP_SMOKE" = false ]; then
  run_smoke_tests
fi

if [ "${NEEDS_SHELL_RELOAD:-}" = true ]; then
  printf '\nNOTE: npm prefix was reconfigured. Restart your terminal or run: source %s\n' "${SHELL_RC:-~/.zshrc}"
fi

printf '\nUpdate complete.\n'
