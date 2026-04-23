#!/usr/bin/env bash

set -euo pipefail

if command -v tmux >/dev/null 2>&1; then
  tmux -V
  exit 0
fi

retry() {
  local max_attempts=$1
  shift
  local attempt=1

  until "$@"; do
    local exit_code=$?
    if (( attempt >= max_attempts )); then
      return "$exit_code"
    fi
    echo "Command failed (attempt ${attempt}/${max_attempts}); retrying in 10s..."
    sleep 10
    attempt=$((attempt + 1))
  done
}

APT_FLAGS=(
  "-o" "Acquire::Retries=3"
  "-o" "Acquire::http::Timeout=30"
  "-o" "Acquire::https::Timeout=30"
)

retry 3 sudo apt-get "${APT_FLAGS[@]}" update
retry 3 sudo apt-get "${APT_FLAGS[@]}" install -y tmux
tmux -V
