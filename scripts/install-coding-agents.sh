#!/bin/sh
set -eu

agents_raw="${1:-${AO_INSTALL_AGENTS:-claude-code,codex,aider,goose}}"
agents_normalized=$(printf '%s' "$agents_raw" | tr ',' ' ' | xargs)

if [ -z "$agents_normalized" ] || [ "$agents_normalized" = "none" ]; then
  echo "Skipping coding agent installation"
  exit 0
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Expected command not found after install: $1" >&2
    exit 1
  fi
}

install_claude_code() {
  npm install -g @anthropic-ai/claude-code
  require_command claude
}

install_codex() {
  npm install -g @openai/codex
  require_command codex
}

install_aider() {
  curl -LsSf https://aider.chat/install.sh | sh
  require_command aider
}

install_goose() {
  curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh |
    CONFIGURE=false bash
  require_command goose
}

for agent in $agents_normalized; do
  case "$agent" in
    all)
      install_claude_code
      install_codex
      install_aider
      install_goose
      ;;
    claude-code)
      install_claude_code
      ;;
    codex)
      install_codex
      ;;
    aider)
      install_aider
      ;;
    goose)
      install_goose
      ;;
    "")
      ;;
    *)
      echo "Unsupported coding agent in AO_INSTALL_AGENTS: $agent" >&2
      exit 1
      ;;
  esac
done
