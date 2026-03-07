#!/usr/bin/env bash
# ao-bus.sh — Shell functions for the agent toolkit.
#
# Sourced by bootstrap.sh before agent launch. Wraps ao-bus-cli
# with convenient short-form commands.
#
# Required env vars (set by bootstrap.sh):
#   AO_AGENT_NAME  - current agent name
#   AO_PHASE       - current phase
#   AO_WORKTREE    - worktree path
#   AO_AGENTS_DIR  - .agents/ directory path
#   AO_FILE_SCOPE  - comma-separated assigned files
#   AO_SHARED_FILES - comma-separated shared files

# Resolve ao-bus-cli binary location
AO_BUS_CLI="${AO_AGENTS_DIR}/bin/ao-bus-cli"

# Fallback: look in PATH
if [ ! -x "$AO_BUS_CLI" ]; then
  AO_BUS_CLI="ao-bus-cli"
fi

# Common flags passed to every command
_ao_flags() {
  echo "--agents-dir" "$AO_AGENTS_DIR" "--agent" "$AO_AGENT_NAME" "--phase" "$AO_PHASE"
}

# === Status Commands ===

ao-status() {
  "$AO_BUS_CLI" status "$@" $(_ao_flags)
}

# === Message Commands ===

ao-msg() {
  "$AO_BUS_CLI" msg "$@" $(_ao_flags)
}

ao-inbox() {
  "$AO_BUS_CLI" inbox "$@" $(_ao_flags)
}

# === Context Commands ===

ao-context() {
  "$AO_BUS_CLI" context "$@" $(_ao_flags)
}

# === Lock Commands ===

ao-lock() {
  "$AO_BUS_CLI" lock "$@" $(_ao_flags)
}

ao-unlock() {
  "$AO_BUS_CLI" unlock "$@" $(_ao_flags)
}

# === Artifact Commands ===

ao-artifact() {
  "$AO_BUS_CLI" artifact "$@" $(_ao_flags)
}

# === Plan Commands ===

ao-plan() {
  "$AO_BUS_CLI" plan "$@" $(_ao_flags)
}

# === Learning Commands ===

ao-learn() {
  "$AO_BUS_CLI" learn "$@" $(_ao_flags)
}

# === Refine Commands ===

ao-refine() {
  "$AO_BUS_CLI" refine "$@" $(_ao_flags)
}
