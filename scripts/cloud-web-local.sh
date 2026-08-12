#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
public_root="$(cd "$root/../.." && pwd)"
readonly public_root
readonly api_url="http://127.0.0.1:${AO_CLOUD_PORT:-8081}"
readonly web_port="${AO_CLOUD_WEB_PORT:-3000}"
export AO_CLOUD_LOCAL_POSTGRES_DATA_DIR="${AO_CLOUD_LOCAL_POSTGRES_DATA_DIR:-${AO_DATA_DIR:-$HOME/.ao}/cloud/postgres}"
readonly provider_key_file="${AO_DATA_DIR:-$HOME/.ao}/cloud/provider-secret-key"

if [[ ! -f "$public_root/packages/product-ui/src/index.ts" || ! -f "$public_root/packages/cloud-client/src/index.ts" ]]; then
	echo "The Cloud web UI must run from private/ao-cloud inside an Agent Orchestrator checkout." >&2
	exit 1
fi

cd "$root"
mkdir -p "$AO_CLOUD_LOCAL_POSTGRES_DATA_DIR"
mkdir -p "$(dirname "$provider_key_file")"
if [[ ! -s "$provider_key_file" ]]; then
	umask 077
	openssl rand -base64 32 >"$provider_key_file"
fi
export AO_CLOUD_PROVIDER_SECRET_KEY
AO_CLOUD_PROVIDER_SECRET_KEY="$(<"$provider_key_file")"
docker compose up --build --detach --remove-orphans

ready=false
for _ in {1..30}; do
	if curl --fail --silent --show-error --max-time 2 "$api_url/readyz" >/dev/null 2>&1; then
		ready=true
		break
	fi
	sleep 2
done
if [[ "$ready" != true ]]; then
	echo "Local Cloud control plane did not become ready at $api_url." >&2
	exit 1
fi

export AO_CLOUD_WEB_MODE=local
export AO_CLOUD_WEB_API_BASE_URL="$api_url"
source "$root/scripts/lib/workos-web-env.sh"
configure_workos_web "$web_port"

printf 'Cloud API: %s\n' "$api_url"
printf 'Cloud web: http://127.0.0.1:%s\n' "$web_port"
printf 'GitHub broker auth: %s via AWS profile %s\n' "$AO_CLOUD_WORKOS_SECRET_ID" "$AO_CLOUD_WORKOS_AWS_PROFILE"
printf 'WorkOS redirect: %s (%s)\n' "$WORKOS_REDIRECT_URI" "$WORKOS_REDIRECT_STATUS"
exec npm run dev -- --hostname 127.0.0.1 --port "$web_port"
