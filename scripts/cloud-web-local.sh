#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
public_root="$(cd "$root/../.." && pwd)"
readonly public_root
readonly api_url="http://127.0.0.1:${AO_CLOUD_PORT:-8081}"
readonly web_port="${AO_CLOUD_WEB_PORT:-3000}"

if [[ ! -f "$public_root/packages/product-ui/src/index.ts" || ! -f "$public_root/packages/cloud-client/src/index.ts" ]]; then
	echo "The Cloud web UI must run from private/ao-cloud inside an Agent Orchestrator checkout." >&2
	exit 1
fi

cd "$root"
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

printf 'Cloud API: %s\n' "$api_url"
printf 'Cloud web: http://127.0.0.1:%s\n' "$web_port"
exec npm run dev -- --hostname 127.0.0.1 --port "$web_port"
