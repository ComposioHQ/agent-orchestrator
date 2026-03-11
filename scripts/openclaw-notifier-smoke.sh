#!/usr/bin/env bash

set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "error: required env var missing: $name" >&2
    exit 1
  fi
}

require_env OPENCLAW_HOOKS_TOKEN
require_env OPENCLAW_HOOKS_URL
require_env AO_DIR
require_env OPENCLAW_CHANNEL_KIND
require_env OPENCLAW_CHANNEL_TARGET

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required" >&2
  exit 1
fi

session_key_prefix="${OPENCLAW_SESSION_KEY_PREFIX:-hook:ao:}"
session_name="${OPENCLAW_SMOKE_SESSION_NAME:-smoke}"
timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
session_key="${session_key_prefix}${session_name}-${timestamp}"
smoke_message="${OPENCLAW_SMOKE_MESSAGE:-AO OpenClaw notifier smoke test}"
sender_name="${OPENCLAW_SENDER_NAME:-AO smoke}"
wake_mode="${OPENCLAW_WAKE_MODE:-now}"
deliver="${OPENCLAW_DELIVER:-true}"

payload="$(
  SESSION_KEY="$session_key" \
  SMOKE_MESSAGE="$smoke_message" \
  SENDER_NAME="$sender_name" \
  WAKE_MODE="$wake_mode" \
  DELIVER="$deliver" \
  OPENCLAW_CHANNEL_KIND="$OPENCLAW_CHANNEL_KIND" \
  OPENCLAW_CHANNEL_TARGET="$OPENCLAW_CHANNEL_TARGET" \
  AO_DIR="$AO_DIR" \
  node <<'EOF'
const payload = {
  message: `${process.env.SMOKE_MESSAGE}\nContext: ${JSON.stringify({
    aoDir: process.env.AO_DIR,
    smoke: true,
    sentAt: new Date().toISOString(),
  })}`,
  name: process.env.SENDER_NAME,
  sessionKey: process.env.SESSION_KEY,
  wakeMode: process.env.WAKE_MODE,
  deliver: process.env.DELIVER === "true",
  channel: process.env.OPENCLAW_CHANNEL_KIND,
  to: process.env.OPENCLAW_CHANNEL_TARGET,
};

process.stdout.write(JSON.stringify(payload));
EOF
)"

echo "OpenClaw notifier smoke test"
echo "  url: $OPENCLAW_HOOKS_URL"
echo "  channel: $OPENCLAW_CHANNEL_KIND"
echo "  to: $OPENCLAW_CHANNEL_TARGET"
echo "  sessionKey: $session_key"
echo "  auth: Bearer [redacted]"
echo "  payload: $payload"

tmp_body="$(mktemp)"
trap 'rm -f "$tmp_body"' EXIT

http_status="$(
  curl -sS \
    -o "$tmp_body" \
    -w "%{http_code}" \
    -X POST "$OPENCLAW_HOOKS_URL" \
    -H "Authorization: Bearer $OPENCLAW_HOOKS_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$payload"
)"

echo "  http_status: $http_status"
echo "  response:"
sed 's/^/    /' "$tmp_body"

if [[ ! "$http_status" =~ ^2 ]]; then
  echo "error: OpenClaw hook request failed" >&2
  exit 1
fi

echo "success: OpenClaw accepted explicit channel/to routing payload"
