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
readonly worker_key_file="${AO_DATA_DIR:-$HOME/.ao}/cloud/worker-signing-key"
readonly control_key_file="${AO_DATA_DIR:-$HOME/.ao}/cloud/environment-control-token"
source "$root/scripts/lib/docker-local.sh"

if [[ ! -f "$public_root/packages/product-ui/src/index.ts" || ! -f "$public_root/packages/cloud-client/src/index.ts" ]]; then
	echo "The Cloud web UI must run from private/ao-cloud inside an Agent Orchestrator checkout." >&2
	exit 1
fi
if ! ao_docker_available; then
	echo "Docker Engine with Compose is required for local Cloud workers." >&2
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
if [[ ! -s "$worker_key_file" ]]; then
	umask 077
	openssl rand -hex 32 >"$worker_key_file"
fi
export AO_CLOUD_WORKER_SIGNING_KEY
AO_CLOUD_WORKER_SIGNING_KEY="$(<"$worker_key_file")"
if [[ ! -s "$control_key_file" ]]; then
	umask 077
	openssl rand -hex 32 >"$control_key_file"
fi
if [[ -z "${AO_CLOUD_REPOSITORY_BROKER_TOKEN:-}" ]] &&
	command -v aws >/dev/null 2>&1 &&
	aws sts get-caller-identity --profile "${AWS_PROFILE:-ao-cloud}" >/dev/null 2>&1; then
	broker_secret="$(
		aws secretsmanager get-secret-value \
			--profile "${AWS_PROFILE:-ao-cloud}" \
			--region "${AWS_REGION:-eu-north-1}" \
			--secret-id "${AO_CLOUD_REPOSITORY_BROKER_SECRET_ID:-ao-cloud/repository-broker}" \
			--query SecretString \
			--output text
	)"
	export AO_CLOUD_REPOSITORY_BROKER_TOKEN
	AO_CLOUD_REPOSITORY_BROKER_TOKEN="$(
		BROKER_SECRET="$broker_secret" python3 -c \
			'import json, os; print(json.loads(os.environ["BROKER_SECRET"])["auth_token"])'
	)"
	unset broker_secret
fi
if [[ -n "${AO_CLOUD_REPOSITORY_BROKER_TOKEN:-}" ]]; then
	export AO_CLOUD_REPOSITORY_BROKER_URL="${AO_CLOUD_REPOSITORY_BROKER_URL:-https://api.aoagents.dev}"
	export AO_CLOUD_ENV_CONTROL_TOKEN
	AO_CLOUD_ENV_CONTROL_TOKEN="$(<"$control_key_file")"
fi
export AO_CLOUD_DOCKER_GID
AO_CLOUD_DOCKER_GID="$(ao_docker_socket_gid)"
docker compose --profile worker-image build worker-image
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
github_broker_auth="disabled (local-only mode)"
if [[ -n "${WORKOS_API_KEY:-}" && -n "${WORKOS_CLIENT_ID:-}" ]] ||
	aws sts get-caller-identity --profile "${AWS_PROFILE:-ao-cloud}" >/dev/null 2>&1; then
	configure_workos_web "$web_port" "127.0.0.1"
	github_broker_auth="${AO_CLOUD_WORKOS_SECRET_ID} via AWS profile ${AO_CLOUD_WORKOS_AWS_PROFILE}"
else
	readonly auth_state_dir="${AO_CLOUD_WEB_STATE_DIR:-$HOME/.ao/cloud-web}"
	readonly auth_cookie_file="$auth_state_dir/auth-cookie-password"
	mkdir -p "$auth_state_dir"
	chmod 700 "$auth_state_dir"
	if [[ ! -s "$auth_cookie_file" ]]; then
		umask 077
		openssl rand -base64 32 >"$auth_cookie_file"
	fi
	export WORKOS_API_KEY="sk_test_local_development_only"
	export WORKOS_CLIENT_ID="client_local_development_only"
	export WORKOS_COOKIE_PASSWORD
	WORKOS_COOKIE_PASSWORD="$(<"$auth_cookie_file")"
	export WORKOS_REDIRECT_URI="http://127.0.0.1:${web_port}/callback"
	export NEXT_PUBLIC_WORKOS_REDIRECT_URI="$WORKOS_REDIRECT_URI"
fi

printf 'Cloud API: %s\n' "$api_url"
printf 'Cloud web: http://127.0.0.1:%s\n' "$web_port"
printf 'GitHub broker auth: %s\n' "$github_broker_auth"
printf 'WorkOS redirect: %s\n' "$WORKOS_REDIRECT_URI"
exec npm run dev -- --hostname 127.0.0.1 --port "$web_port"
