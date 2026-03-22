#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export HOME="$TMP_DIR/home"
export TMP_GH_LOG="$TMP_DIR/gh.log"
mkdir -p "$HOME/.integrator-sessions" "$TMP_DIR/bin"

cat > "$HOME/.integrator-sessions/integrator-1" <<'EOF'
branch=feat/rest-dashboard
pr=https://github.com/ComposioHQ/integrator/pull/123
status=working
summary=Testing dashboard API usage
EOF

cat > "$TMP_DIR/bin/tmux" <<'EOF'
#!/bin/bash
set -euo pipefail

case "$1" in
  list-sessions)
    echo "integrator-1"
    ;;
  display-message)
    exit 0
    ;;
  capture-pane)
    exit 0
    ;;
  list-panes)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF

cat > "$TMP_DIR/bin/git" <<'EOF'
#!/bin/bash
set -euo pipefail

if [[ "$1" == "branch" && "$2" == "--show-current" ]]; then
  echo "feat/rest-dashboard"
fi
EOF

cat > "$TMP_DIR/bin/gh" <<'EOF'
#!/bin/bash
set -euo pipefail

printf '%s\n' "$*" >> "$TMP_GH_LOG"

if [[ "$1" == "pr" && "$2" == "list" ]]; then
  echo "https://github.com/ComposioHQ/integrator/pull/123"
  exit 0
fi

if [[ "$1" == "pr" && "$2" == "view" ]]; then
  cat <<'JSON'
{"title":"Dashboard REST test","state":"OPEN","mergeable":"MERGEABLE","reviewDecision":"APPROVED","additions":12,"deletions":3,"createdAt":"2026-03-22T10:00:00Z"}
JSON
  exit 0
fi

if [[ "$1" == "pr" && "$2" == "checks" ]]; then
  cat <<'JSON'
[{"name":"Unified Validation","state":"SUCCESS","link":"https://ci.example/123"}]
JSON
  exit 0
fi

if [[ "$1" == "api" && "$2" == "graphql" ]]; then
  if printf '%s' "$*" | grep -q 'statusCheckRollup'; then
    echo "dashboard should not request CI rollup via GraphQL" >&2
    exit 9
  fi
  cat <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}
JSON
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
EOF

chmod +x "$TMP_DIR/bin/tmux" "$TMP_DIR/bin/git" "$TMP_DIR/bin/gh"

PATH="$TMP_DIR/bin:$PATH" bash "$ROOT_DIR/scripts/claude-dashboard" --regen-only >/dev/null

if ! grep -q '^pr checks ' "$TMP_GH_LOG"; then
  echo "expected gh pr checks to be used for dashboard CI fetches" >&2
  exit 1
fi

if grep -q 'statusCheckRollup' "$TMP_GH_LOG"; then
  echo "dashboard should not query statusCheckRollup via GraphQL" >&2
  exit 1
fi
