#!/bin/bash
# Shared helper: ensure npm global prefix is user-writable.
#
# Sources this file from setup.sh, ao-update.sh, ao-doctor.sh to avoid
# duplicating the prefix-fix logic. After sourcing, npm link will write
# to a user-owned directory without sudo.
#
# Exports:
#   NPM_PREFIX          — the (possibly reconfigured) npm prefix
#   NEEDS_SHELL_RELOAD  — "true" if the prefix was changed this run
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/ensure-npm-prefix.sh"

NPM_PREFIX="$(npm config get prefix)"
NEEDS_SHELL_RELOAD=false

if [ ! -w "$NPM_PREFIX" ] 2>/dev/null; then
  USER_NPM_DIR="$HOME/.npm-global"
  echo "  npm prefix ($NPM_PREFIX) is not user-writable."
  echo "  Configuring user-local prefix: $USER_NPM_DIR"
  if ! mkdir -p "$USER_NPM_DIR" || ! npm config set prefix "$USER_NPM_DIR"; then
    echo "ERROR: Failed to configure user-local npm prefix."
    echo "  Fix manually:"
    echo "    mkdir -p ~/.npm-global"
    echo "    npm config set prefix '~/.npm-global'"
    echo '    export PATH="$HOME/.npm-global/bin:$PATH"'
    exit 1
  fi
  NPM_PREFIX="$USER_NPM_DIR"
  NEEDS_SHELL_RELOAD=true

  # Make npm link work in this process
  export PATH="$USER_NPM_DIR/bin:$PATH"

  # Persist to shell profile
  SHELL_RC=""
  if [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
  fi

  if [ -n "$SHELL_RC" ]; then
    if ! grep -q 'npm-global/bin' "$SHELL_RC" 2>/dev/null; then
      echo '' >> "$SHELL_RC"
      echo '# npm user-local global bin (added by AO setup)' >> "$SHELL_RC"
      echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$SHELL_RC"
      echo "  Added PATH entry to $SHELL_RC"
    fi
  else
    echo "  Add this to your shell profile:"
    echo '    export PATH="$HOME/.npm-global/bin:$PATH"'
  fi
fi
