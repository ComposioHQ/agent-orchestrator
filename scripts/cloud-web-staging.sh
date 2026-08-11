#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
public_root="$(cd "$root/../.." && pwd)"
readonly public_root
readonly api_url="${AO_CLOUD_STAGING_URL:-https://staging-api.aoagents.dev}"
readonly web_port="${AO_CLOUD_WEB_PORT:-3000}"
readonly aws_profile="${AWS_PROFILE:-ao-cloud}"
readonly secret_id="${AO_CLOUD_STAGING_WORKOS_SECRET_ID:-ao-cloud/staging/workos}"
readonly state_dir="${AO_CLOUD_WEB_STATE_DIR:-$HOME/.ao/cloud-web}"
readonly cookie_file="$state_dir/auth-cookie-password"

if [[ ! -f "$public_root/packages/product-ui/src/index.ts" || ! -f "$public_root/packages/cloud-client/src/index.ts" ]]; then
	echo "The Cloud web UI must run from private/ao-cloud inside an Agent Orchestrator checkout." >&2
	exit 1
fi
if [[ "$api_url" != https://* ]]; then
	echo "AO_CLOUD_STAGING_URL must be an HTTPS origin." >&2
	exit 1
fi
if ! curl --fail --silent --show-error --max-time 10 --proto '=https' --tlsv1.2 "$api_url/readyz" >/dev/null; then
	echo "The staging control plane is not ready at $api_url." >&2
	exit 1
fi

secret_json="$(
	aws secretsmanager get-secret-value \
		--profile "$aws_profile" \
		--secret-id "$secret_id" \
		--query SecretString \
		--output text
)"
workos_api_key="$(
	SECRET_JSON="$secret_json" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["SECRET_JSON"])
names = ("api_key", "apiKey", "WORKOS_API_KEY")
value = next((payload.get(name) for name in names if payload.get(name)), "")
if not value:
    raise SystemExit(f"WorkOS secret is missing one of: {', '.join(names)}")
print(value)
PY
)"
workos_client_id="$(
	SECRET_JSON="$secret_json" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["SECRET_JSON"])
names = ("client_id", "clientId", "WORKOS_CLIENT_ID")
value = next((payload.get(name) for name in names if payload.get(name)), "")
if not value:
    raise SystemExit(f"WorkOS secret is missing one of: {', '.join(names)}")
print(value)
PY
)"
unset secret_json

mkdir -p "$state_dir"
chmod 700 "$state_dir"
if [[ ! -s "$cookie_file" ]]; then
	umask 077
	openssl rand -base64 32 >"$cookie_file"
fi

export AO_CLOUD_WEB_MODE=staging
export AO_CLOUD_WEB_API_BASE_URL="${api_url%/}"
export WORKOS_API_KEY="$workos_api_key"
export WORKOS_CLIENT_ID="$workos_client_id"
unset workos_api_key workos_client_id
export WORKOS_COOKIE_PASSWORD
WORKOS_COOKIE_PASSWORD="$(<"$cookie_file")"
export WORKOS_REDIRECT_URI="http://localhost:${web_port}/callback"
export NEXT_PUBLIC_WORKOS_REDIRECT_URI="$WORKOS_REDIRECT_URI"

redirect_status="$(
	python3 - <<'PY'
import json
import os
import urllib.error
import urllib.request

target = os.environ["WORKOS_REDIRECT_URI"]
headers = {
    "Authorization": f"Bearer {os.environ['WORKOS_API_KEY']}",
    "Content-Type": "application/json",
}
request = urllib.request.Request(
    "https://api.workos.com/user_management/redirect_uris?limit=100",
    headers=headers,
)
with urllib.request.urlopen(request, timeout=20) as response:
    payload = json.load(response)
items = payload.get("data") or payload.get("redirect_uris") or []
if any(item.get("uri") == target for item in items if isinstance(item, dict)):
    print("present")
else:
    body = json.dumps({"uri": target}).encode()
    request = urllib.request.Request(
        "https://api.workos.com/user_management/redirect_uris",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20):
            pass
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise
    print("created")
PY
)"

printf 'Cloud API: %s\n' "$AO_CLOUD_WEB_API_BASE_URL"
printf 'Cloud web: http://localhost:%s\n' "$web_port"
printf 'WorkOS credentials: %s via AWS profile %s\n' "$secret_id" "$aws_profile"
printf 'WorkOS redirect: %s (%s)\n' "$WORKOS_REDIRECT_URI" "$redirect_status"
cd "$root"
exec npm run dev -- --hostname 127.0.0.1 --port "$web_port"
