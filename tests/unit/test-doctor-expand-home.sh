#!/usr/bin/env bash
# Unit test for expand_home() in scripts/ao-doctor.sh
#
# Reproduces the bug where unquoted ~/*)  case pattern causes bash to
# tilde-expand the pattern itself at parse time, so a literal "~/" input
# never matches and paths are silently returned unexpanded.
#
# Run: bash tests/unit/test-doctor-expand-home.sh

set -euo pipefail

PASS=0; FAIL=0

run_test() {
  local label="$1" fn="$2" input="$3" expected="$4"
  local result
  result=$("$fn" "$input")
  if [[ "$result" == "$expected" ]]; then
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS+1))
  else
    printf "  FAIL  %s\n        got:      %s\n        expected: %s\n" \
      "$label" "$result" "$expected"
    FAIL=$((FAIL+1))
  fi
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Source production expand_home from ao-doctor.sh (script returns early when sourced)
# shellcheck source=../../scripts/ao-doctor.sh
source "$REPO_ROOT/scripts/ao-doctor.sh"

HOME_DIR="${HOME:-}"

# ── RED: broken version (unquoted ~/*) — demonstrates the bug
expand_home_broken() {
  local DEFAULT_CONFIG_HOME="$HOME_DIR"
  case "$1" in
    ~/*)
      printf '%s/%s' "$DEFAULT_CONFIG_HOME" "${1#~/}"
      ;;
    *)
      printf '%s' "$1"
      ;;
  esac
}

echo ""
echo "=== RED: broken version (demonstrates the bug) ==="
# Literal tilde strings are intentional — simulate user-provided paths with unexpanded ~
# shellcheck disable=SC2088
run_test "tilde path silently not expanded" \
  expand_home_broken "~/.agent-orchestrator" "$HOME_DIR/.agent-orchestrator"
run_test "absolute path passthrough" \
  expand_home_broken "/abs/path" "/abs/path"

echo ""
echo "=== GREEN: production expand_home from scripts/ao-doctor.sh ==="
# Literal tilde strings are intentional — simulate user-provided paths with unexpanded ~
# shellcheck disable=SC2088
run_test "tilde path expands correctly" \
  expand_home "~/.agent-orchestrator" "$HOME_DIR/.agent-orchestrator"
# shellcheck disable=SC2088
run_test "nested tilde path expands correctly" \
  expand_home "~/.config/ao/config.yaml" "$HOME_DIR/.config/ao/config.yaml"
run_test "absolute path passthrough" \
  expand_home "/abs/path" "/abs/path"
run_test "relative path passthrough" \
  expand_home "relative/path" "relative/path"

echo ""
echo "Results: PASS=$PASS FAIL=$FAIL"

# We expect exactly 1 failure (the RED case proving the bug) and rest passing
EXPECTED_FAIL=1
if [[ $FAIL -eq $EXPECTED_FAIL ]]; then
  echo "OK — bug reproduced in RED, all GREEN tests pass."
  exit 0
else
  echo "UNEXPECTED — expected $EXPECTED_FAIL failure(s), got $FAIL"
  exit 1
fi
