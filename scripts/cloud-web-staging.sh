#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
public_root="$(cd "$root/../.." && pwd)"
readonly public_root
readonly api_url="${AO_CLOUD_STAGING_URL:-https://staging-api.aoagents.dev}"
readonly web_port="${AO_CLOUD_WEB_PORT:-3000}"

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

export AO_CLOUD_WEB_MODE=staging
export AO_CLOUD_WEB_API_BASE_URL="${api_url%/}"
source "$root/scripts/lib/workos-web-env.sh"
configure_workos_web "$web_port"

printf 'Cloud API: %s\n' "$AO_CLOUD_WEB_API_BASE_URL"
printf 'Cloud web: http://localhost:%s\n' "$web_port"
printf 'WorkOS credentials: %s via AWS profile %s\n' "$AO_CLOUD_WORKOS_SECRET_ID" "$AO_CLOUD_WORKOS_AWS_PROFILE"
printf 'WorkOS redirect: %s (%s)\n' "$WORKOS_REDIRECT_URI" "$WORKOS_REDIRECT_STATUS"
cd "$root"
exec npm run dev -- --hostname 127.0.0.1 --port "$web_port"
